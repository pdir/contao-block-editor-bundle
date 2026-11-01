<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\Element;

use Pdir\ContaoBlockEditorBundle\Element\ElementUpdater;
use PHPUnit\Framework\TestCase;

final class ElementUpdaterTest extends TestCase
{
    public function testReportsFieldsChangedByCallbacks(): void
    {
        $before = ['id' => 1, 'tstamp' => 1, 'text' => 'a', 'cssID' => 'x', 'cssStyleSelector' => '6', 'title' => 't'];
        $after = ['id' => 1, 'tstamp' => 2, 'text' => 'b', 'cssID' => '', 'cssStyleSelector' => null, 'title' => 't'];

        $this->assertSame(['cssID', 'cssStyleSelector'], ElementUpdater::changedBySideEffect($before, $after, ['text']));
    }

    public function testDoesNotReportSentFieldsOrTheTimestamp(): void
    {
        $this->assertSame([], ElementUpdater::changedBySideEffect(['tstamp' => 1, 'text' => 'a'], ['tstamp' => 2, 'text' => 'b'], ['text']));
    }
}
