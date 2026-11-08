<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\Record;

use Pdir\ContaoBlockEditorBundle\Record\ShownTexts;
use PHPUnit\Framework\TestCase;

final class ShownTextsTest extends TestCase
{
    public function testKeepsTheTextsByRecordWithoutEmptyFields(): void
    {
        $texts = new ShownTexts();
        $texts->set('tl_calendar_events', 5, ['startDate' => '23.11.2026', 'startTime' => '17:00–19:00']);
        $texts->set('tl_calendar_events', 6, ['startDate' => '28.11.2026', 'startTime' => '']);
        $texts->set('tl_calendar_events', 7, ['startDate' => '', 'startTime' => '']);

        $this->assertSame([
            'tl_calendar_events.5' => ['startDate' => '23.11.2026', 'startTime' => '17:00–19:00'],
            'tl_calendar_events.6' => ['startDate' => '28.11.2026'],
        ], $texts->all());
    }

    public function testShowsTheTextAsThePageDoes(): void
    {
        $this->assertSame('17:00–19:00', ShownTexts::plain('17:00&ndash;19:00'));
        $this->assertSame('23.11.2026', ShownTexts::plain(' <span>23.11.2026</span> '));
        $this->assertSame('', ShownTexts::plain(null));
        $this->assertSame('', ShownTexts::plain(1700000000));
    }
}
