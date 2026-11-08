<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\DataContainer;

use Pdir\ContaoBlockEditorBundle\DataContainer\VirtualFields;
use PHPUnit\Framework\TestCase;

final class VirtualFieldsTest extends TestCase
{
    protected function setUp(): void
    {
        $GLOBALS['TL_DCA']['tl_content']['fields'] = [
            'perPage' => ['inputType' => 'text', 'sql' => 'smallint'],
            'serverPagination' => ['inputType' => 'checkbox', 'targetColumn' => 'jsonData'],
            'other' => ['inputType' => 'text', 'targetColumn' => 'jsonData'],
            'jsonData' => ['virtualTarget' => true, 'sql' => ['type' => 'json']],
        ];
    }

    protected function tearDown(): void
    {
        unset($GLOBALS['TL_DCA']);
    }

    public function testShowsTheFieldsOfTheStorage(): void
    {
        $row = VirtualFields::expand(['id' => 1, 'perPage' => 6, 'jsonData' => '{"serverPagination":"1","unknown":"x"}'], 'tl_content');

        $this->assertSame('1', $row['serverPagination']);
        $this->assertNull($row['other']);
        $this->assertArrayNotHasKey('unknown', $row);
        $this->assertSame('{"serverPagination":"1","unknown":"x"}', $row['jsonData']);
    }

    public function testKeepsTheOtherValuesOfTheStorage(): void
    {
        $submit = VirtualFields::combine(['serverPagination' => '', 'perPage' => 3, 'tstamp' => 5], ['jsonData' => '{"other":"a","unknown":"x"}'], 'tl_content');

        $this->assertSame(['perPage' => 3, 'tstamp' => 5, 'jsonData' => '{"other":"a","unknown":"x","serverPagination":""}'], $submit);
    }

    public function testStartsAnEmptyStorage(): void
    {
        $this->assertSame(['jsonData' => '{"serverPagination":"1"}'], VirtualFields::combine(['serverPagination' => '1'], ['jsonData' => null], 'tl_content'));
        $this->assertSame(['jsonData' => '{"serverPagination":"1"}'], VirtualFields::combine(['serverPagination' => '1'], ['jsonData' => 'broken'], 'tl_content'));
    }

    public function testNamesTheStoragesOfFields(): void
    {
        $this->assertSame(['jsonData'], VirtualFields::storagesOf(['serverPagination', 'other', 'perPage'], 'tl_content'));
        $this->assertSame([], VirtualFields::storagesOf(['perPage'], 'tl_content'));
    }
}
