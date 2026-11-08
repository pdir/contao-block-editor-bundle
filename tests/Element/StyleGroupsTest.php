<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\Element;

use Contao\System;
use Pdir\ContaoBlockEditorBundle\Element\StyleGroups;
use PHPUnit\Framework\TestCase;
use Symfony\Component\DependencyInjection\Container;

final class StyleGroupsTest extends TestCase
{
    protected function tearDown(): void
    {
        System::setContainer(new Container());
    }

    public function testDescribesTheOfferedGroups(): void
    {
        $this->withGroups();

        $this->assertSame(
            [[
                'id' => '2',
                'label' => 'Abstand',
                'description' => 'Nach oben und unten',
                'category' => 'Layout',
                'multiple' => true,
                'options' => [['value' => 'pt-1', 'label' => 'Klein'], ['value' => 'pt-2 pb-2', 'label' => 'Groß']],
            ]],
            StyleGroups::describe([['value' => '2', 'label' => 'Abstand'], ['value' => '9', 'label' => 'Gelöscht']]),
        );
    }

    public function testPassesTheChoiceByGroup(): void
    {
        $this->withGroups();

        $this->assertSame(
            ['1' => ['bg-dark'], '2' => ['pt-2 pb-2']],
            StyleGroups::toWidgetInput(['pt-2 pb-2', 'bg-dark', 'unknown'], [['value' => '1', 'label' => 'Hintergrund'], ['value' => '2', 'label' => 'Abstand']]),
        );
    }

    public function testNeedsTheBundle(): void
    {
        System::setContainer(new Container());

        $this->assertNull(StyleGroups::describe([['value' => '1', 'label' => 'Hintergrund']]));
        $this->assertSame([], StyleGroups::toWidgetInput(['bg-dark'], [['value' => '1', 'label' => 'Hintergrund']]));
    }

    private function withGroups(): void
    {
        $container = new Container();
        $container->set('Craffft\\CssStyleSelectorBundle\\Repository\\CssStyleRepository', new class {
            public function findGroups(): array
            {
                return [
                    1 => ['id' => 1, 'title' => 'Hintergrund', 'description' => '', 'categoryTitle' => 'Farben', 'multiple' => false, 'styles' => ['bg-light' => 'Hell', 'bg-dark' => 'Dunkel']],
                    2 => ['id' => 2, 'title' => 'Abstand', 'description' => 'Nach oben und unten', 'categoryTitle' => 'Layout', 'multiple' => true, 'styles' => ['pt-1' => 'Klein', 'pt-2 pb-2' => 'Groß']],
                ];
            }
        });

        System::setContainer($container);
    }
}
