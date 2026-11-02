<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\Element;

use Contao\CoreBundle\Framework\ContaoFramework;
use Doctrine\DBAL\Connection;
use Pdir\ContaoBlockEditorBundle\Element\ElementInspector;
use Pdir\ContaoBlockEditorBundle\Security\FieldPolicy;
use PHPUnit\Framework\TestCase;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\Routing\RouterInterface;

final class ElementInspectorTest extends TestCase
{
    protected function setUp(): void
    {
        $GLOBALS['TL_DCA']['tl_content'] = [
            'palettes' => ['text' => '{text_legend},text'],
            'fields' => [
                'text' => ['inputType' => 'textarea', 'sql' => 'text NULL'],
                'sectionHeadline' => ['inputType' => 'inputUnit', 'sql' => 'text NULL'],
            ],
        ];
    }

    protected function tearDown(): void
    {
        unset($GLOBALS['TL_DCA']);
    }

    public function testElementInAnAccordionCanEditTheHeadlineOfItsSection(): void
    {
        $fields = $this->inspector('accordion')->getEditableFields(['type' => 'text', 'ptable' => 'tl_content', 'pid' => 5]);

        self::assertSame(['text', 'sectionHeadline'], $fields);
    }

    public function testElementInAnotherParentHasNoSectionHeadline(): void
    {
        $fields = $this->inspector('element_group')->getEditableFields(['type' => 'text', 'ptable' => 'tl_content', 'pid' => 5]);

        self::assertSame(['text'], $fields);
    }

    public function testElementInAnArticleDoesNotAskForAParent(): void
    {
        $connection = $this->createMock(Connection::class);
        $connection->expects(self::never())->method('fetchOne');

        $fields = $this->inspector('accordion', $connection)->getEditableFields(['type' => 'text', 'ptable' => 'tl_article', 'pid' => 5]);

        self::assertSame(['text'], $fields);
    }

    private function inspector(string $parentType, Connection|null $connection = null): ElementInspector
    {
        if (!$connection) {
            $connection = $this->createMock(Connection::class);
            $connection->method('fetchOne')->willReturn($parentType);
        }

        $security = $this->createMock(Security::class);
        $security->method('isGranted')->willReturn(true);

        return new ElementInspector(
            $this->createMock(ContaoFramework::class),
            $connection,
            $security,
            new FieldPolicy($security),
            $this->createMock(RouterInterface::class),
        );
    }
}
