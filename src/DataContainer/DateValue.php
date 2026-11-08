<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\DataContainer;

/**
 * Dates, times and both, such as "Anzeigen ab": stored as timestamps, typed in the inspector in
 * the format of the browser's date fields. The back end shows them in the format of the settings,
 * which the widget validates, see RecordWriter.
 */
final class DateValue
{
    public const RGXPS = ['date', 'time', 'datim'];

    private const FORMATS = ['date' => 'Y-m-d', 'time' => 'H:i', 'datim' => 'Y-m-d\TH:i'];

    public static function isDate(array $config): bool
    {
        return \in_array($config['eval']['rgxp'] ?? null, self::RGXPS, true);
    }

    /**
     * The stored timestamp as the browser's date field expects it, empty if there is none.
     */
    public static function toInput(mixed $timestamp, string $rgxp): string
    {
        if (!isset(self::FORMATS[$rgxp]) || !is_numeric($timestamp) || '' === trim((string) $timestamp)) {
            return '';
        }

        return date(self::FORMATS[$rgxp], (int) $timestamp);
    }

    /**
     * The timestamp of a value from the browser's date field, null if it is not one.
     */
    public static function fromInput(mixed $value, string $rgxp): int|null
    {
        if (!isset(self::FORMATS[$rgxp]) || !\is_string($value)) {
            return null;
        }

        // Some browsers add seconds to times
        if ('date' !== $rgxp && 1 === preg_match('/:\d\d:\d\d$/', $value)) {
            $value = substr($value, 0, -3);
        }

        // "!" starts a time on the first of January 1970, as the core stores times
        $date = \DateTimeImmutable::createFromFormat('!'.self::FORMATS[$rgxp], $value);

        if (false === $date || $date->format(self::FORMATS[$rgxp]) !== $value) {
            return null;
        }

        return $date->getTimestamp();
    }
}
