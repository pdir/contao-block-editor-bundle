<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\DependencyInjection;

use Symfony\Component\Config\FileLocator;
use Symfony\Component\DependencyInjection\ContainerBuilder;
use Symfony\Component\DependencyInjection\Extension\Extension;
use Symfony\Component\DependencyInjection\Loader\YamlFileLoader;

class ContaoBlockEditorExtension extends Extension
{
    public function getAlias(): string
    {
        return 'contao_block_editor';
    }

    public function load(array $configs, ContainerBuilder $container): void
    {
        $config = $this->processConfiguration(new Configuration(), $configs);
        $container->setParameter('contao_block_editor.editor_scripts', $config['editor_scripts']);

        (new YamlFileLoader($container, new FileLocator(\dirname(__DIR__, 2).'/config')))->load('services.yaml');
    }
}
