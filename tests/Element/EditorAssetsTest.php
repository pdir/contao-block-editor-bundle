<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\Element;

use Pdir\ContaoBlockEditorBundle\Element\EditorAssets;
use PHPUnit\Framework\TestCase;

final class EditorAssetsTest extends TestCase
{
    private string $webDir;

    protected function setUp(): void
    {
        $this->webDir = sys_get_temp_dir().'/cbe-'.bin2hex(random_bytes(6));
        mkdir($this->webDir.'/bundles/contaoblockeditor', 0777, true);

        foreach (['shell.js', 'shell.css', 'frame.js', 'frame.css', 'rich-editor.js', 'restore-settings.js', 'preview-menu.js', 'nav-pages.js', 'reader-record.js', 'inserter.js'] as $file) {
            copy(__DIR__.'/../../public/'.$file, $this->webDir.'/bundles/contaoblockeditor/'.$file);
        }
    }

    protected function tearDown(): void
    {
        array_map(unlink(...), glob($this->webDir.'/bundles/contaoblockeditor/*') ?: []);
        rmdir($this->webDir.'/bundles/contaoblockeditor');
        rmdir($this->webDir.'/bundles');
        rmdir($this->webDir);
    }

    public function testAcceptsMatchingFiles(): void
    {
        $this->assertTrue((new EditorAssets($this->webDir))->isDeployed());
    }

    public function testRejectsAnOutdatedCopy(): void
    {
        file_put_contents($this->webDir.'/bundles/contaoblockeditor/frame.js', '// old build');

        $this->assertFalse((new EditorAssets($this->webDir))->isDeployed());
    }

    public function testRejectsMissingFiles(): void
    {
        unlink($this->webDir.'/bundles/contaoblockeditor/shell.js');

        $this->assertFalse((new EditorAssets($this->webDir))->isDeployed());
    }

    public function testVersionsUrlsByContent(): void
    {
        $this->assertMatchesRegularExpression(
            '#^/base/bundles/contaoblockeditor/frame\.js\?v=[0-9a-f]{32}$#',
            (new EditorAssets($this->webDir))->url('frame.js', '/base'),
        );
    }
}
