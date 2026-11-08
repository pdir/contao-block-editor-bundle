<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Element;

use Contao\CoreBundle\Security\ContaoCorePermissions;
use Contao\CoreBundle\Security\DataContainer\ReadAction;
use Contao\CoreBundle\Security\DataContainer\UpdateAction;
use Contao\DataContainer;
use Contao\Versions;
use Doctrine\DBAL\Connection;
use Pdir\ContaoBlockEditorBundle\DataContainer\EditContext;
use Pdir\ContaoBlockEditorBundle\DataContainer\EditorDataContainer;
use Pdir\ContaoBlockEditorBundle\DataContainer\VirtualFields;
use Pdir\ContaoBlockEditorBundle\Exception\ApiException;
use Psr\Log\LoggerInterface;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpFoundation\RequestStack;

/**
 * The only write path of the editor. It follows DC_Table's order of operations:
 * permissions, widget validation (including HTML sanitizing with the allowed tags
 * from the settings), save callbacks, permissions on the new values, persist,
 * cache invalidation and versioning.
 */
final class ElementUpdater
{
    private const TABLE = ElementInspector::TABLE;

    public function __construct(
        private readonly Connection $connection,
        private readonly Security $security,
        private readonly ElementInspector $inspector,
        private readonly RequestStack $requestStack,
        private readonly LoggerInterface $logger,
        private readonly RecordWriter $writer,
    ) {
    }

    /**
     * @param array<string, mixed> $values
     *
     * @return array{revision: string, values: array<string, mixed>, sideEffects?: list<string>}
     */
    public function update(int $id, string $revision, array $values): array
    {
        if ([] === $values) {
            throw new ApiException(400, 'Keine Änderungen übergeben.');
        }

        $this->inspector->loadDca();

        $this->connection->beginTransaction();

        try {
            $result = $this->doUpdate($id, $revision, $values);
            $this->connection->commit();
        } catch (\Throwable $exception) {
            $this->connection->rollBack();

            throw $exception;
        }

        return $result;
    }

    /**
     * @param array<string, mixed> $values
     *
     * @return array{revision: string, values: array<string, mixed>, sideEffects?: list<string>}
     */
    private function doUpdate(int $id, string $revision, array $values): array
    {
        // Lock the record, so that the revision check and the update are atomic
        $row = $this->connection->fetchAssociative('SELECT * FROM tl_content WHERE id = ? FOR UPDATE', [$id]);

        if (false === $row || !\in_array($row['ptable'], ElementInspector::supportedPtables(), true)) {
            throw new ApiException(404, 'Das Element wurde nicht gefunden.');
        }

        $this->denyUnlessGranted(new ReadAction(self::TABLE, $row));
        $this->denyUnlessGranted(new UpdateAction(self::TABLE, $row));

        if (!hash_equals(ElementInspector::revision($row), $revision)) {
            throw new ApiException(409, 'Das Element wurde zwischenzeitlich geändert. Bitte die Seite neu laden.');
        }

        // Virtual fields as fields of the record, see VirtualFields
        $record = VirtualFields::expand($row, self::TABLE);
        $dc = new EditorDataContainer(self::TABLE, $record);

        // As for the edit form of the back end: other bundles add their fields to the palettes here
        EditContext::load(self::TABLE, $dc, $this->requestStack->getCurrentRequest());

        $allowed = $this->inspector->getEditableFields($row);

        $this->requestStack->getCurrentRequest()?->request->set('FORM_SUBMIT', self::TABLE);

        $submit = [];
        $errors = [];

        foreach (array_keys($values) as $field) {
            if (!\in_array($field, $allowed, true)) {
                // Same answer for unknown and forbidden fields
                throw new ApiException(403, 'Dieses Feld darf hier nicht bearbeitet werden.', ['field' => (string) $field]);
            }
        }

        foreach ($values as $field => $value) {
            try {
                $validated = $this->writer->validateField(self::TABLE, $field, $value, $record, $dc);

                if ($validated['save']) {
                    $submit[$field] = $validated['value'];
                }
            } catch (ApiException $exception) {
                if (422 !== $exception->status) {
                    throw $exception;
                }

                $errors[$field] = $exception->getMessage();
            }
        }

        if ($errors) {
            throw new ApiException(422, 'Bitte die Eingaben prüfen.', ['errors' => $errors]);
        }

        if ([] === $submit) {
            return ['revision' => ElementInspector::revision($row), 'values' => []];
        }

        $submit['tstamp'] = time();
        $submit = VirtualFields::combine($this->writer->runBeforeSubmitCallbacks(self::TABLE, $submit, $dc), $row, self::TABLE);

        // The voters get to see the new values, e.g. to deny a forbidden element type
        $this->denyUnlessGranted(new UpdateAction(self::TABLE, $row, $submit));

        $versions = new Versions(self::TABLE, $id);
        $versions->setEditUrl($this->inspector->classicUrl($row));
        $versions->initialize();

        $this->connection->update(
            'tl_content',
            array_combine(array_map($this->connection->quoteIdentifier(...), array_keys($submit)), $submit),
            ['id' => $id],
        );

        DataContainer::clearCurrentRecordCache($id, self::TABLE);

        $updated = $this->connection->fetchAssociative('SELECT * FROM tl_content WHERE id = ?', [$id]);

        \assert(\is_array($updated));

        $dc = new EditorDataContainer(self::TABLE, VirtualFields::expand($updated, self::TABLE));

        $this->writer->runRecordCallbacks(self::TABLE, 'onsubmit_callback', $dc);
        $dc->invalidateCacheTags();

        if ($this->writer->shouldVersion(self::TABLE, $submit)) {
            $versions->create();
        }

        // Callbacks can change the record, so the response must reflect the final state
        $final = $this->connection->fetchAssociative('SELECT * FROM tl_content WHERE id = ?', [$id]);

        \assert(\is_array($final));

        $result = [
            'revision' => ElementInspector::revision($final),
            'values' => (array) ($this->inspector->getElements([$id])[$id]['values'] ?? []),
        ];

        // The storage of a virtual field changes with it
        $sent = [...array_keys($values), ...VirtualFields::storagesOf(array_keys($values), self::TABLE)];

        if ($changed = self::changedBySideEffect($row, $final, $sent)) {
            // Callbacks are allowed to do this, but it must not go unnoticed
            $this->logger->warning('Saving a content element also changed other fields.', ['id' => $id, 'sent' => array_keys($values), 'changed' => $changed]);
            $result['sideEffects'] = $this->labels($changed);
        }

        return $result;
    }

    /**
     * The columns that changed although they were not part of the request.
     *
     * @param array<string, mixed> $before
     * @param array<string, mixed> $after
     * @param list<string>         $sent
     *
     * @return list<string>
     */
    public static function changedBySideEffect(array $before, array $after, array $sent): array
    {
        $changed = [];

        foreach ($after as $column => $value) {
            if ('tstamp' !== $column && !\in_array($column, $sent, true) && ($before[$column] ?? null) !== $value) {
                $changed[] = (string) $column;
            }
        }

        return $changed;
    }

    /**
     * @param list<string> $fields
     *
     * @return list<string>
     */
    private function labels(array $fields): array
    {
        return array_map(
            static fn (string $field): string => (string) ($GLOBALS['TL_DCA'][self::TABLE]['fields'][$field]['label'][0] ?? $GLOBALS['TL_LANG'][self::TABLE][$field][0] ?? $field),
            $fields,
        );
    }

    private function denyUnlessGranted(ReadAction|UpdateAction $action): void
    {
        if (!$this->security->isGranted(ContaoCorePermissions::DC_PREFIX.self::TABLE, $action)) {
            // Don't reveal whether the element exists
            throw new ApiException(404, 'Das Element wurde nicht gefunden.');
        }
    }
}
