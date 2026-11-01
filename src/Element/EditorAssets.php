<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Element;

/**
 * URLs of the editor assets, versioned by content. Shell and frame exchange messages,
 * so a browser must never combine a cached old file with a new one. This only runs
 * for the editor, so hashing the small files does not affect regular visitors.
 */
final class EditorAssets
{
    private const SOURCE_DIR = __DIR__.'/../../public/';
    private const PUBLIC_DIR = '/bundles/contaoblockeditor/';
    private const FILES = ['shell.js', 'shell.css', 'frame.js', 'frame.css'];

    /** @var array<string, string> */
    private array $versions = [];

    public function __construct(private readonly string $webDir)
    {
    }

    /**
     * Whether the public copies match this version of the bundle. Unless assets:install
     * created symlinks, they can lag behind after an update. Old scripts do not understand
     * the current API and could damage content, so the editor must not start with them.
     */
    public function isDeployed(): bool
    {
        foreach (self::FILES as $file) {
            $deployed = $this->webDir.self::PUBLIC_DIR.$file;

            if (!is_file($deployed) || hash_file('xxh128', $deployed) !== $this->version($file)) {
                return false;
            }
        }

        return true;
    }

    public function url(string $file, string $basePath): string
    {
        return $basePath.self::PUBLIC_DIR.$file.'?v='.$this->version($file);
    }

    private function version(string $file): string
    {
        return $this->versions[$file] ??= (string) hash_file('xxh128', self::SOURCE_DIR.$file);
    }
}
