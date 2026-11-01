<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Element;

use Contao\CoreBundle\Exception\ResponseException;
use Contao\CoreBundle\Security\ContaoCorePermissions;
use Contao\CoreBundle\Security\DataContainer\ReadAction;
use Contao\CoreBundle\Security\DataContainer\UpdateAction;
use Contao\DataContainer;
use Contao\System;
use Contao\Versions;
use Contao\Widget;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\Exception as DbalException;
use Pdir\ContaoBlockEditorBundle\DataContainer\EditorDataContainer;
use Pdir\ContaoBlockEditorBundle\Exception\ApiException;
use Psr\Log\LoggerInterface;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\Routing\RouterInterface;

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
        private readonly RouterInterface $router,
        private readonly RequestStack $requestStack,
        private readonly LoggerInterface $logger,
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

        if (false === $row || !\in_array($row['ptable'], ElementInspector::SUPPORTED_PTABLES, true)) {
            throw new ApiException(404, 'Das Element wurde nicht gefunden.');
        }

        $this->denyUnlessGranted(new ReadAction(self::TABLE, $row));
        $this->denyUnlessGranted(new UpdateAction(self::TABLE, $row));

        if (!hash_equals(ElementInspector::revision($row), $revision)) {
            throw new ApiException(409, 'Das Element wurde zwischenzeitlich geändert. Bitte die Seite neu laden.');
        }

        $allowed = $this->inspector->getEditableFields($row);

        foreach (array_keys($values) as $field) {
            if (!\in_array($field, $allowed, true)) {
                // Same answer for unknown and forbidden fields
                throw new ApiException(403, 'Dieses Feld darf hier nicht bearbeitet werden.', ['field' => (string) $field]);
            }
        }

        $dc = new EditorDataContainer(self::TABLE, $row);

        $this->runRecordCallbacks('onload_callback', $dc);

        // Callbacks may have adjusted the DCA for this record, so check again
        $allowed = $this->inspector->getEditableFields($row);

        $this->requestStack->getCurrentRequest()?->request->set('FORM_SUBMIT', self::TABLE);

        $submit = [];
        $errors = [];

        foreach ($values as $field => $value) {
            if (!\in_array($field, $allowed, true)) {
                throw new ApiException(403, 'Dieses Feld darf hier nicht bearbeitet werden.', ['field' => (string) $field]);
            }

            try {
                $validated = $this->validateField($field, $value, $row, $dc);

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
        $submit = $this->runBeforeSubmitCallbacks($submit, $dc);

        // The voters get to see the new values, e.g. to deny a forbidden element type
        $this->denyUnlessGranted(new UpdateAction(self::TABLE, $row, $submit));

        $versions = new Versions(self::TABLE, $id);
        $versions->setEditUrl($this->router->generate('contao_backend', ['do' => 'article', 'table' => self::TABLE, 'act' => 'edit', 'id' => $id]));
        $versions->initialize();

        $this->connection->update(
            'tl_content',
            array_combine(array_map($this->connection->quoteIdentifier(...), array_keys($submit)), $submit),
            ['id' => $id],
        );

        DataContainer::clearCurrentRecordCache($id, self::TABLE);

        $updated = $this->connection->fetchAssociative('SELECT * FROM tl_content WHERE id = ?', [$id]);

        \assert(\is_array($updated));

        $dc = new EditorDataContainer(self::TABLE, $updated);

        $this->runRecordCallbacks('onsubmit_callback', $dc);
        $dc->invalidateCacheTags();

        if ($this->shouldVersion($submit)) {
            $versions->create();
        }

        // Callbacks can change the record, so the response must reflect the final state
        $final = $this->connection->fetchAssociative('SELECT * FROM tl_content WHERE id = ?', [$id]);

        \assert(\is_array($final));

        $result = [
            'revision' => ElementInspector::revision($final),
            'values' => (array) ($this->inspector->getElements([$id])[$id]['values'] ?? []),
        ];

        if ($changed = self::changedBySideEffect($row, $final, array_keys($values))) {
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

    /**
     * @param array<string, mixed> $row
     *
     * @return array{save: bool, value: mixed}
     */
    private function validateField(string $field, mixed $value, array $row, EditorDataContainer $dc): array
    {
        $config = $GLOBALS['TL_DCA'][self::TABLE]['fields'][$field];

        // The shape must match the field: a string would overwrite all parts of a
        // multi-value field such as cssID.
        $expectsArray = 'inputUnit' === $config['inputType'] || !empty($config['eval']['multiple']);

        if (\is_array($value) !== $expectsArray || (!\is_array($value) && !\is_scalar($value))) {
            throw new ApiException(400, 'Ungültiger Wert.');
        }

        $class = $GLOBALS['BE_FFL'][$config['inputType']] ?? null;

        if (!\is_string($class) || !class_exists($class)) {
            throw new ApiException(400, 'Dieses Feld wird nicht unterstützt.');
        }

        $dc->setField($field);

        /** @var Widget $widget */
        $widget = new $class($class::getAttributesFromDca($config, $field, $row[$field] ?? null, $field, self::TABLE, $dc));

        // Widgets read the request's POST data; that path applies the core's encoding and
        // HTML sanitizing in each Contao version. Input::setPost() would not work here:
        // Contao 6 widgets without HTML ignore it and would save an empty value.
        $post = $this->requestStack->getCurrentRequest()?->request ?? throw new \LogicException('No current request.');
        $post->set($field, \is_bool($value) ? ($value ? '1' : '') : $value);
        $widget->validate();
        $post->remove($field);

        if ($widget->hasErrors()) {
            throw new ApiException(422, strip_tags((string) $widget->getErrorAsString()));
        }

        $newValue = $widget->value;

        // Fail closed: a value must never silently turn into an empty one
        if (\in_array($newValue, ['', null], true) && !\in_array($value, ['', false, []], true)) {
            throw new ApiException(422, 'Der Wert konnte nicht übernommen werden.');
        }

        try {
            foreach ($config['save_callback'] ?? [] as $callback) {
                $newValue = \is_array($callback)
                    ? System::importStatic($callback[0])->{$callback[1]}($newValue, $dc)
                    : $callback($newValue, $dc);
            }
        } catch (ResponseException|DbalException $exception) {
            // Redirects and database errors are not validation messages
            throw $exception;
        } catch (\Exception $exception) {
            // Contract of save_callback: the exception message is a user-facing error
            throw new ApiException(422, $exception->getMessage());
        }

        if (\is_array($newValue)) {
            $newValue = [] === $newValue ? '' : serialize($newValue);
        }

        if ('' === (string) $newValue) {
            if (!empty($config['eval']['doNotSaveEmpty'])) {
                return ['save' => false, 'value' => null];
            }

            $newValue = Widget::getEmptyValueByFieldType($config['sql']);
        }

        return ['save' => true, 'value' => $newValue];
    }

    private function denyUnlessGranted(ReadAction|UpdateAction $action): void
    {
        if (!$this->security->isGranted(ContaoCorePermissions::DC_PREFIX.self::TABLE, $action)) {
            // Don't reveal whether the element exists
            throw new ApiException(404, 'Das Element wurde nicht gefunden.');
        }
    }

    private function runRecordCallbacks(string $key, EditorDataContainer $dc): void
    {
        foreach ($GLOBALS['TL_DCA'][self::TABLE]['config'][$key] ?? [] as $callback) {
            \is_array($callback)
                ? System::importStatic($callback[0])->{$callback[1]}($dc)
                : $callback($dc);
        }
    }

    /**
     * @param array<string, mixed> $submit
     *
     * @return array<string, mixed>
     */
    private function runBeforeSubmitCallbacks(array $submit, EditorDataContainer $dc): array
    {
        foreach ($GLOBALS['TL_DCA'][self::TABLE]['config']['onbeforesubmit_callback'] ?? [] as $callback) {
            $submit = \is_array($callback)
                ? System::importStatic($callback[0])->{$callback[1]}($submit, $dc)
                : $callback($submit, $dc);

            if (!\is_array($submit)) {
                throw new \RuntimeException('The onbeforesubmit_callback must return the values!');
            }
        }

        return $submit;
    }

    /**
     * @param array<string, mixed> $submit
     */
    private function shouldVersion(array $submit): bool
    {
        foreach (array_keys($submit) as $field) {
            if ('tstamp' !== $field && false !== ($GLOBALS['TL_DCA'][self::TABLE]['fields'][$field]['eval']['versionize'] ?? true)) {
                return true;
            }
        }

        return false;
    }
}
