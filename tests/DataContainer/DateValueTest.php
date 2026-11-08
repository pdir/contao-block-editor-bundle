<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\DataContainer;

use Pdir\ContaoBlockEditorBundle\DataContainer\DateValue;
use PHPUnit\Framework\TestCase;

final class DateValueTest extends TestCase
{
    private string $timezone;

    protected function setUp(): void
    {
        $this->timezone = date_default_timezone_get();
        date_default_timezone_set('Europe/Berlin');
    }

    protected function tearDown(): void
    {
        date_default_timezone_set($this->timezone);
    }

    public function testShowsTimestampsInTheFormatOfTheBrowser(): void
    {
        $timestamp = mktime(14, 30, 0, 11, 6, 2026);

        $this->assertSame('2026-11-06T14:30', DateValue::toInput((string) $timestamp, 'datim'));
        $this->assertSame('2026-11-06', DateValue::toInput($timestamp, 'date'));
        $this->assertSame('14:30', DateValue::toInput($timestamp, 'time'));
        $this->assertSame('', DateValue::toInput('', 'datim'));
        $this->assertSame('', DateValue::toInput(null, 'datim'));
    }

    public function testReadsTheValuesOfTheBrowser(): void
    {
        $this->assertSame(mktime(14, 30, 0, 11, 6, 2026), DateValue::fromInput('2026-11-06T14:30', 'datim'));
        $this->assertSame(mktime(14, 30, 0, 11, 6, 2026), DateValue::fromInput('2026-11-06T14:30:00', 'datim'));
        $this->assertSame(mktime(0, 0, 0, 11, 6, 2026), DateValue::fromInput('2026-11-06', 'date'));
        $this->assertSame(mktime(14, 30, 0, 1, 1, 1970), DateValue::fromInput('14:30', 'time'));
    }

    public function testRejectsOtherValues(): void
    {
        $this->assertNull(DateValue::fromInput('06.11.2026 14:30', 'datim'));
        $this->assertNull(DateValue::fromInput('2026-02-30', 'date'));
        $this->assertNull(DateValue::fromInput('2026-11-06', 'datim'));
        $this->assertNull(DateValue::fromInput(['2026-11-06'], 'date'));
        $this->assertNull(DateValue::fromInput('2026-11-06', 'unknown'));
    }
}
