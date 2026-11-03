<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Security;

use Contao\CoreBundle\Security\ContaoCorePermissions;
use Contao\DataContainer;
use Symfony\Bundle\SecurityBundle\Security;

/**
 * Decides which DCA fields the block editor may touch. Allowlist: anything not
 * explicitly understood stays in the classic back end form, where the core
 * handles it. The same policy drives the schema (read) and the updater (write).
 */
final class FieldPolicy
{
    private const SUPPORTED_INPUT_TYPES = ['text', 'textarea', 'select', 'checkbox', 'radio', 'inputUnit', 'tableWizard'];

    /** Columns that define a record's identity, position or type. */
    private const PROTECTED_FIELDS = ['id', 'pid', 'ptable', 'sorting', 'tstamp', 'type'];

    /** Eval flags that need core logic which this bundle does not replicate. */
    private const UNSUPPORTED_EVAL = ['preserveTags', 'useRawRequestData', 'unique', 'fallback', 'readonly', 'disabled', 'doNotShow', 'csv', 'encrypt'];

    public function __construct(private readonly Security $security)
    {
    }

    /**
     * Whether the field can be handled at all, regardless of the current user.
     *
     * @param array<string, mixed> $config
     */
    public function isSupported(string $field, array $config): bool
    {
        if (\in_array($field, self::PROTECTED_FIELDS, true)) {
            return false;
        }

        if (!\in_array($config['inputType'] ?? null, self::SUPPORTED_INPUT_TYPES, true)) {
            return false;
        }

        // Only real columns; virtual fields are combined by the core on save
        if (!isset($config['sql']) || isset($config['input_field_callback']) || isset($config['targetColumn'])) {
            return false;
        }

        $eval = $config['eval'] ?? [];

        if (isset($eval['virtualTarget'])) {
            return false;
        }

        foreach (self::UNSUPPORTED_EVAL as $flag) {
            if (!empty($eval[$flag])) {
                return false;
            }
        }

        // Date values need a format conversion in DC_Table
        if (\in_array($eval['rgxp'] ?? null, ['date', 'time', 'datim'], true)) {
            return false;
        }

        // Code editors (ace) keep their markup; only tinyMCE fields are rich text
        $rte = $eval['rte'] ?? null;

        return null === $rte || str_starts_with((string) $rte, 'tiny');
    }

    public function canEdit(string $table, string $field): bool
    {
        return !DataContainer::isFieldExcluded($table, $field)
            || $this->security->isGranted(ContaoCorePermissions::USER_CAN_EDIT_FIELD_OF_TABLE, $table.'::'.$field);
    }

    /**
     * @return list<string> Field names of a palette, including its subpalettes
     */
    public static function paletteFields(string $palette): array
    {
        $fields = [];

        foreach (preg_split('/[,;]/', $palette) ?: [] as $part) {
            $part = trim($part);

            if ('' !== $part && !str_starts_with($part, '{') && !str_starts_with($part, '[')) {
                $fields[] = $part;
            }
        }

        return array_values(array_unique($fields));
    }
}
