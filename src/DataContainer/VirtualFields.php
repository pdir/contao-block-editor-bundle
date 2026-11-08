<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\DataContainer;

use Contao\StringUtil;

/**
 * Fields without a column of their own: Contao stores them together as JSON in a storage column
 * ("jsonData"), such as the server side pagination of a gallery. The record shows them as fields
 * and a save writes them back into their storage, next to the values that are there already.
 */
final class VirtualFields
{
    /**
     * @return array<string, string> The storage column by field
     */
    public static function of(string $table): array
    {
        $fields = [];

        foreach ($GLOBALS['TL_DCA'][$table]['fields'] ?? [] as $name => $config) {
            $target = \is_array($config) ? ($config['targetColumn'] ?? null) : null;

            if (\is_string($name) && \is_string($target) && '' !== $target && !empty($GLOBALS['TL_DCA'][$table]['fields'][$target]['virtualTarget'])) {
                $fields[$name] = $target;
            }
        }

        return $fields;
    }

    /**
     * The record with the values of its virtual fields. The storage columns stay as they are.
     *
     * @param array<string, mixed> $row
     *
     * @return array<string, mixed>
     */
    public static function expand(array $row, string $table): array
    {
        $storages = [];

        foreach (self::of($table) as $field => $target) {
            $storages[$target] ??= self::decode($row[$target] ?? null);
            $row[$field] = $storages[$target][$field] ?? null;
        }

        return $row;
    }

    /**
     * The values to save with the virtual fields written into their storage columns.
     *
     * @param array<string, mixed> $submit
     * @param array<string, mixed> $row    The record as stored, with the storage columns
     *
     * @return array<string, mixed>
     */
    public static function combine(array $submit, array $row, string $table): array
    {
        $storages = [];

        foreach (self::of($table) as $field => $target) {
            if (!\array_key_exists($field, $submit)) {
                continue;
            }

            $storages[$target] ??= self::decode($row[$target] ?? null);
            $storages[$target][$field] = StringUtil::ensureStringUuids($submit[$field]);
            unset($submit[$field]);
        }

        foreach ($storages as $target => $data) {
            $submit[$target] = json_encode($data, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
        }

        return $submit;
    }

    /**
     * The storage columns of the given fields, which change when the fields do.
     *
     * @param list<string> $fields
     *
     * @return list<string>
     */
    public static function storagesOf(array $fields, string $table): array
    {
        return array_values(array_unique(array_intersect_key(self::of($table), array_flip($fields))));
    }

    /**
     * @return array<string, mixed>
     */
    private static function decode(mixed $value): array
    {
        if (\is_array($value)) {
            return $value;
        }

        if (!\is_string($value) || '' === $value) {
            return [];
        }

        try {
            $decoded = json_decode($value, true, flags: JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [];
        }

        return \is_array($decoded) ? $decoded : [];
    }
}
