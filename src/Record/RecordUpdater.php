<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Record;

use Contao\CoreBundle\Security\DataContainer\ReadAction;
use Contao\CoreBundle\Security\DataContainer\UpdateAction;
use Contao\DataContainer;
use Contao\Versions;
use Doctrine\DBAL\Connection;
use Pdir\ContaoBlockEditorBundle\DataContainer\EditorDataContainer;
use Pdir\ContaoBlockEditorBundle\Element\ElementInspector;
use Pdir\ContaoBlockEditorBundle\Element\RecordWriter;
use Pdir\ContaoBlockEditorBundle\Exception\ApiException;
use Pdir\ContaoBlockEditorBundle\Security\FieldPolicy;
use Symfony\Component\HttpFoundation\RequestStack;

/**
 * Saves the headline of a news or event from its reader page, on the same path as the
 * back end: permissions, validation, callbacks and versioning.
 */
final class RecordUpdater
{
    public function __construct(
        private readonly Connection $connection,
        private readonly ReaderRecord $records,
        private readonly FieldPolicy $fieldPolicy,
        private readonly RecordWriter $writer,
        private readonly RequestStack $requestStack,
    ) {
    }

    /**
     * @param array<string, mixed> $values
     *
     * @return array<string, mixed>
     */
    public function update(string $table, int $id, string $revision, array $values): array
    {
        if (!ReaderRecord::supports($table)) {
            throw new ApiException(404, 'Der Eintrag wurde nicht gefunden.');
        }

        $this->records->loadDca($table);
        $this->connection->beginTransaction();

        try {
            $this->doUpdate($table, $id, $revision, $values);
            $this->connection->commit();
        } catch (\Throwable $exception) {
            $this->connection->rollBack();

            throw $exception;
        }

        return $this->records->describe($table, $id) ?? throw new ApiException(404, 'Der Eintrag wurde nicht gefunden.');
    }

    /**
     * @param array<string, mixed> $values
     */
    private function doUpdate(string $table, int $id, string $revision, array $values): void
    {
        // Lock the record, so that the revision check and the update are atomic
        $row = $this->connection->fetchAssociative('SELECT * FROM '.$table.' WHERE id = ? FOR UPDATE', [$id]);

        if (false === $row || !$this->records->isGranted($table, new ReadAction($table, $row))) {
            throw new ApiException(404, 'Der Eintrag wurde nicht gefunden.');
        }

        $fields = $this->records->fields($table);

        foreach (array_keys($values) as $field) {
            if (!\in_array($field, $fields, true) || !$this->fieldPolicy->canEdit($table, $field) || !$this->records->isGranted($table, new UpdateAction($table, $row))) {
                throw new ApiException(403, 'Dieses Feld darf nicht bearbeitet werden.', ['field' => $field]);
            }
        }

        if (!hash_equals(ElementInspector::revision($row), $revision)) {
            throw new ApiException(409, 'Der Eintrag wurde zwischenzeitlich geändert. Bitte die Seite neu laden.');
        }

        $dc = new EditorDataContainer($table, $row);

        $this->writer->runRecordCallbacks($table, 'onload_callback', $dc);
        $this->requestStack->getCurrentRequest()?->request->set('FORM_SUBMIT', $table);

        $submit = [];
        $errors = [];

        foreach ($values as $field => $value) {
            try {
                $validated = $this->writer->validateField($table, $field, $value, $row, $dc);
            } catch (ApiException $exception) {
                if (422 !== $exception->status) {
                    throw $exception;
                }

                $errors[$field] = $exception->getMessage();

                continue;
            }

            if ($validated['save']) {
                $submit[$field] = $validated['value'];
            }
        }

        if ($errors) {
            throw new ApiException(422, 'Bitte die Eingaben prüfen.', ['errors' => $errors]);
        }

        if (!$submit) {
            return;
        }

        $submit = $this->writer->runBeforeSubmitCallbacks($table, [...$submit, 'tstamp' => time()], $dc);

        // The voters get to see the new values
        if (!$this->records->isGranted($table, new UpdateAction($table, $row, $submit))) {
            throw new ApiException(403, 'Dieser Eintrag darf nicht bearbeitet werden.');
        }

        $versions = new Versions($table, $id);
        $versions->setEditUrl($this->records->classicUrl($table, $id));
        $versions->initialize();

        $this->connection->update(
            $table,
            array_combine(array_map($this->connection->quoteIdentifier(...), array_keys($submit)), $submit),
            ['id' => $id],
        );

        DataContainer::clearCurrentRecordCache($id, $table);

        $updated = $this->connection->fetchAssociative('SELECT * FROM '.$table.' WHERE id = ?', [$id]);

        \assert(\is_array($updated));

        $dc = new EditorDataContainer($table, $updated);

        $this->writer->runRecordCallbacks($table, 'onsubmit_callback', $dc);
        $dc->invalidateCacheTags();

        if ($this->writer->shouldVersion($table, $submit)) {
            $versions->create();
        }
    }
}
