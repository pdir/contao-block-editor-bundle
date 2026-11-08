<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Element;

use Contao\System;

/**
 * The field of the CSS style selector ("CSS-Stil Auswahl"): one choice per style group, stored
 * as the list of the chosen CSS classes. Its options are the groups the user may use for the
 * record; the styles of each group come from the bundle's repository. Without the bundle, or
 * with a version that works differently, the field stays in the classic back end.
 */
final class StyleGroups
{
    public const INPUT_TYPE = 'cssStyleSelector';

    private const REPOSITORY = 'Craffft\\CssStyleSelectorBundle\\Repository\\CssStyleRepository';

    /**
     * @param list<array{value: string, label: string}> $offered The groups of the options callback
     *
     * @return list<array{id: string, label: string, description: string, category: string, multiple: bool, options: list<array{value: string, label: string}>}>|null
     */
    public static function describe(array $offered): array|null
    {
        $groups = self::groups();

        if (null === $groups) {
            return null;
        }

        $described = [];

        foreach ($offered as $option) {
            $group = $groups[(int) $option['value']] ?? null;

            if (null === $group) {
                continue;
            }

            $described[] = [
                'id' => (string) $option['value'],
                'label' => (string) ($group['title'] ?? $option['label']),
                'description' => (string) ($group['description'] ?? ''),
                'category' => (string) ($group['categoryTitle'] ?? ''),
                'multiple' => !empty($group['multiple']),
                'options' => array_map(
                    static fn (string|int $value, mixed $title): array => ['value' => (string) $value, 'label' => (string) $title],
                    array_keys($group['styles']),
                    array_values($group['styles']),
                ),
            ];
        }

        return $described;
    }

    /**
     * The chosen styles as the widget takes them: by group.
     *
     * @param list<string>                                $values
     * @param list<array{value: string, label: string}>|mixed $offered
     *
     * @return array<string, list<string>>
     */
    public static function toWidgetInput(array $values, mixed $offered): array
    {
        $input = [];

        foreach (self::describe(\is_array($offered) ? array_values(array_filter($offered, \is_array(...))) : []) ?? [] as $group) {
            $input[$group['id']] = array_values(array_intersect($values, array_column($group['options'], 'value')));
        }

        return $input;
    }

    /**
     * @return array<int, array<string, mixed>>|null
     */
    private static function groups(): array|null
    {
        $container = System::getContainer();

        if (!$container->has(self::REPOSITORY)) {
            return null;
        }

        try {
            $repository = $container->get(self::REPOSITORY);
            $groups = method_exists($repository, 'findGroups') ? $repository->findGroups() : null;
        } catch (\Throwable) {
            return null;
        }

        if (!\is_array($groups)) {
            return null;
        }

        return array_filter($groups, static fn (mixed $group): bool => \is_array($group) && \is_array($group['styles'] ?? null));
    }
}
