<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\DependencyInjection;

use Pdir\ContaoBlockEditorBundle\DependencyInjection\Configuration;
use Pdir\ContaoBlockEditorBundle\Element\EditorAssets;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Config\Definition\Exception\InvalidConfigurationException;
use Symfony\Component\Config\Definition\Processor;

final class ConfigurationTest extends TestCase
{
    public function testEditorScriptsOfOtherBundlesAreLoadedFromThisWebsite(): void
    {
        $config = (new Processor())->processConfiguration(new Configuration(), [['editor_scripts' => ['bundles/acme/editor.js']]]);
        $assets = new EditorAssets('/web', $config['editor_scripts']);

        self::assertSame(['/sub/bundles/acme/editor.js'], $assets->extensionUrls('/sub'));
        self::assertSame([], (new Processor())->processConfiguration(new Configuration(), [])['editor_scripts']);
    }

    #[DataProvider('foreignScripts')]
    public function testScriptsFromElsewhereAreRefused(string $path): void
    {
        $this->expectException(InvalidConfigurationException::class);

        (new Processor())->processConfiguration(new Configuration(), [['editor_scripts' => [$path]]]);
    }

    public static function foreignScripts(): iterable
    {
        yield 'other host' => ['//cdn.example.com/editor.js'];
        yield 'with a scheme' => ['https://cdn.example.com/editor.js'];
        yield 'data' => ['data:text/javascript,alert(1)'];
        yield 'outside of the public directory' => ['../vendor/editor.js'];
        yield 'empty' => [''];
    }
}
