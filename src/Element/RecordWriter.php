<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Element;

use Contao\CoreBundle\Exception\ResponseException;
use Contao\System;
use Contao\Widget;
use Doctrine\DBAL\Exception as DbalException;
use Pdir\ContaoBlockEditorBundle\DataContainer\EditorDataContainer;
use Pdir\ContaoBlockEditorBundle\Exception\ApiException;
use Symfony\Component\HttpFoundation\RequestStack;

/**
 * The steps of DC_Table's save path that do not depend on the table: widget validation
 * (including HTML sanitizing with the allowed tags from the settings), the DCA callbacks
 * and the decision whether to create a version. Used for content elements and pages.
 */
final class RecordWriter
{
    private const MAX_TABLE_ROWS = 500;
    private const MAX_TABLE_COLUMNS = 50;
    private const MAX_LIST_ITEMS = 500;

    public function __construct(private readonly RequestStack $requestStack)
    {
    }

    /**
     * @param array<string, mixed> $row
     *
     * @return array{save: bool, value: mixed}
     */
    public function validateField(string $table, string $field, mixed $value, array $row, EditorDataContainer $dc): array
    {
        $config = $GLOBALS['TL_DCA'][$table]['fields'][$field];

        // The shape must match the field: a string would overwrite all parts of a
        // multi-value field such as cssID.
        $expectsArray = 'inputUnit' === $config['inputType'] || !empty($config['eval']['multiple']);

        if (\is_array($value) !== $expectsArray || (!\is_array($value) && !\is_scalar($value))) {
            throw new ApiException(400, 'Ungültiger Wert.');
        }

        if ('tableWizard' === $config['inputType'] && !self::isTable($value)) {
            throw new ApiException(400, 'Ungültige Tabelle.');
        }

        if ('listWizard' === $config['inputType'] && !self::isList($value)) {
            throw new ApiException(400, 'Ungültige Liste.');
        }

        $class = $GLOBALS['BE_FFL'][$config['inputType']] ?? null;

        if (!\is_string($class) || !class_exists($class)) {
            throw new ApiException(400, 'Dieses Feld wird nicht unterstützt.');
        }

        $dc->setField($field);

        /** @var Widget $widget */
        $widget = new $class($class::getAttributesFromDca($config, $field, $row[$field] ?? null, $field, $table, $dc));

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


    /**
     * Rows of cells, as the table wizard of the back end sends them: all rows equally long.
     */
    public static function isTable(mixed $value): bool
    {
        if (!\is_array($value) || !array_is_list($value) || \count($value) > self::MAX_TABLE_ROWS) {
            return false;
        }

        $width = null;

        foreach ($value as $row) {
            if (!\is_array($row) || !array_is_list($row) || [] === $row || \count($row) > self::MAX_TABLE_COLUMNS || ($width ??= \count($row)) !== \count($row)) {
                return false;
            }

            foreach ($row as $cell) {
                if (!\is_string($cell)) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Items of a list, as the list wizard of the back end sends them.
     */
    public static function isList(mixed $value): bool
    {
        if (!\is_array($value) || !array_is_list($value) || [] === $value || \count($value) > self::MAX_LIST_ITEMS) {
            return false;
        }

        foreach ($value as $item) {
            if (!\is_string($item)) {
                return false;
            }
        }

        return true;
    }

    public function runRecordCallbacks(string $table, string $key, EditorDataContainer $dc): void
    {
        foreach ($GLOBALS['TL_DCA'][$table]['config'][$key] ?? [] as $callback) {
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
    public function runBeforeSubmitCallbacks(string $table, array $submit, EditorDataContainer $dc): array
    {
        foreach ($GLOBALS['TL_DCA'][$table]['config']['onbeforesubmit_callback'] ?? [] as $callback) {
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
    public function shouldVersion(string $table, array $submit): bool
    {
        foreach (array_keys($submit) as $field) {
            if ('tstamp' !== $field && false !== ($GLOBALS['TL_DCA'][$table]['fields'][$field]['eval']['versionize'] ?? true)) {
                return true;
            }
        }

        return false;
    }
}
