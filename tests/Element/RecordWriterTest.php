<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\Element;

use Pdir\ContaoBlockEditorBundle\Element\ElementInspector;
use Pdir\ContaoBlockEditorBundle\Element\RecordWriter;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class RecordWriterTest extends TestCase
{
    #[DataProvider('tables')]
    public function testAcceptsOnlyRowsOfEqualLength(mixed $value, bool $expected): void
    {
        $this->assertSame($expected, RecordWriter::isTable($value));
    }

    public static function tables(): iterable
    {
        yield 'rows' => [[['a', 'b'], ['c', '<b>d</b>']], true];
        yield 'empty' => [[], true];
        yield 'not a list' => [['x' => ['a']], false];
        yield 'cells not a list' => [[['x' => 'a']], false];
        yield 'uneven rows' => [[['a', 'b'], ['c']], false];
        yield 'empty row' => [[[]], false];
        yield 'nested cell' => [[[['a']]], false];
        yield 'number cell' => [[[1]], false];
        yield 'string' => ['a', false];
        yield 'too many columns' => [[array_fill(0, 51, '')], false];
        yield 'too many rows' => [array_fill(0, 501, ['a']), false];
    }

    #[DataProvider('lists')]
    public function testAcceptsOnlyItemsAsStrings(mixed $value, bool $expected): void
    {
        $this->assertSame($expected, RecordWriter::isList($value));
    }

    public static function lists(): iterable
    {
        yield 'items' => [['a', '<b>b</b>', ''], true];
        yield 'empty' => [[], false];
        yield 'not a list' => [['x' => 'a'], false];
        yield 'nested item' => [[['a']], false];
        yield 'number item' => [[1], false];
        yield 'string' => ['a', false];
        yield 'too many items' => [array_fill(0, 501, 'a'), false];
    }

    public function testListItemsAreEditedInThePage(): void
    {
        $this->assertSame([['field' => 'listitems', 'selector' => 'ul, ol', 'mode' => 'list']], ElementInspector::inlineFields('list', ['listitems', 'listtype']));
        $this->assertSame([], ElementInspector::inlineFields('list', ['listtype']));
    }

    public function testTableCellsAreEditedInThePage(): void
    {
        $this->assertSame([['field' => 'tableitems', 'selector' => 'table', 'mode' => 'table']], ElementInspector::inlineFields('table', ['tableitems', 'summary']));
        $this->assertSame([], ElementInspector::inlineFields('table', ['summary']));
    }
}
