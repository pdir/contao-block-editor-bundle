<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\Element;

use Pdir\ContaoBlockEditorBundle\Element\ElementMover;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ElementMoverTest extends TestCase
{
    /**
     * @param list<int> $sortings
     */
    #[DataProvider('positions')]
    public function testFindsTheSorting(array $sortings, int $index, int|null $expected): void
    {
        $this->assertSame($expected, ElementMover::sortingAt($sortings, $index));
    }

    public static function positions(): iterable
    {
        yield 'no siblings' => [[], 0, 128];
        yield 'at the start' => [[128, 256], 0, 64];
        yield 'between' => [[128, 256], 1, 192];
        yield 'at the end' => [[128, 256], 2, 384];
        yield 'no gap between' => [[128, 129], 1, null];
        yield 'same sorting' => [[128, 128], 1, null];
        yield 'no gap at the start' => [[1, 2], 0, null];
    }
}
