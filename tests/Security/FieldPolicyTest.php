<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\Security;

use Pdir\ContaoBlockEditorBundle\Security\FieldPolicy;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Bundle\SecurityBundle\Security;

final class FieldPolicyTest extends TestCase
{
    /**
     * @param array<string, mixed> $config
     */
    #[DataProvider('fields')]
    public function testSupport(string $field, array $config, bool $expected): void
    {
        $policy = new FieldPolicy($this->createStub(Security::class));

        $this->assertSame($expected, $policy->isSupported($field, $config));
    }

    public static function fields(): iterable
    {
        $text = ['inputType' => 'text', 'sql' => 'varchar(255)'];

        yield 'plain text' => ['cssClass', $text, true];
        yield 'rich text' => ['text', ['inputType' => 'textarea', 'sql' => 'text', 'eval' => ['rte' => 'tinyMCE']], true];

        foreach (['id', 'pid', 'ptable', 'sorting', 'tstamp', 'type'] as $field) {
            yield "protected column $field" => [$field, $text, false];
        }

        yield 'table' => ['tableitems', ['inputType' => 'tableWizard', 'sql' => 'blob', 'eval' => ['multiple' => true, 'allowHtml' => true]], true];
        yield 'list' => ['listitems', ['inputType' => 'listWizard', 'sql' => 'blob', 'eval' => ['multiple' => true, 'allowHtml' => true]], true];
        yield 'unfiltered html' => ['unfilteredHtml', ['inputType' => 'textarea', 'sql' => 'text', 'eval' => ['preserveTags' => true]], false];
        yield 'code editor' => ['code', ['inputType' => 'textarea', 'sql' => 'text', 'eval' => ['rte' => 'ace|html']], false];
        yield 'raw request data' => ['raw', [...$text, 'eval' => ['useRawRequestData' => true]], false];
        yield 'virtual field' => ['virtual', [...$text, 'eval' => ['virtualTarget' => 'jsonData']], false];
        yield 'no column' => ['nocol', ['inputType' => 'text'], false];
        yield 'unknown widget' => ['custom', ['inputType' => 'myWidget', 'sql' => 'text'], false];
        yield 'password' => ['secret', ['inputType' => 'password', 'sql' => 'text'], false];
        yield 'custom rendering' => ['custom', [...$text, 'input_field_callback' => ['a', 'b']], false];
        yield 'read-only' => ['locked', [...$text, 'eval' => ['readonly' => true]], false];
        yield 'date' => ['start', [...$text, 'eval' => ['rgxp' => 'datim']], false];
    }

    public function testExtractsFieldsFromPalettes(): void
    {
        $this->assertSame(
            ['type', 'headline', 'text', 'protected', 'cssID'],
            FieldPolicy::paletteFields('{type_legend},type,headline;{text_legend},text;{protected_legend:hide},protected;[extra],cssID'),
        );
    }
}
