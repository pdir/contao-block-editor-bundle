<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Record;

/**
 * How the templates of a page show fields that are formatted for it, such as the date and
 * time of an event. The page can only find those by their text: the editor frame gets them
 * with its script (see EditorFrameListener).
 */
final class ShownTexts
{
    /** By record key, such as "tl_calendar_events.5": the field and its text. @var array<string, array<string, string>> */
    private array $texts = [];

    /**
     * @param array<string, string> $fields
     */
    public function set(string $table, int $id, array $fields): void
    {
        $fields = array_filter($fields, static fn (string $text): bool => '' !== $text);

        if ($fields) {
            $this->texts[$table.'.'.$id] = $fields;
        }
    }

    /**
     * @return array<string, array<string, string>>
     */
    public function all(): array
    {
        return $this->texts;
    }

    public static function plain(mixed $value): string
    {
        return \is_string($value) || $value instanceof \Stringable ? trim(html_entity_decode(strip_tags((string) $value), ENT_QUOTES | ENT_HTML5)) : '';
    }
}
