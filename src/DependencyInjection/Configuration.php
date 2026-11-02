<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\DependencyInjection;

use Symfony\Component\Config\Definition\Builder\TreeBuilder;
use Symfony\Component\Config\Definition\ConfigurationInterface;

class Configuration implements ConfigurationInterface
{
    public function getConfigTreeBuilder(): TreeBuilder
    {
        $treeBuilder = new TreeBuilder('contao_block_editor');

        $treeBuilder->getRootNode()
            ->children()
                ->arrayNode('editor_scripts')
                    ->info('Scripts of other bundles that extend the rich text editor, relative to the public directory (e.g. "bundles/acme/block-editor.js").')
                    ->scalarPrototype()
                        ->validate()
                            // Only scripts of this website: they run with the rights of the editor
                            ->ifTrue(static fn (mixed $path): bool => !\is_string($path) || '' === $path || str_contains($path, '//') || str_contains($path, ':') || str_contains($path, '..'))
                            ->thenInvalid('Editor scripts must be paths below the public directory, got %s.')
                        ->end()
                    ->end()
                    ->defaultValue([])
                ->end()
            ->end()
        ;

        return $treeBuilder;
    }
}
