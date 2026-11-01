<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Element;

use Contao\Controller;
use Contao\CoreBundle\Framework\ContaoFramework;
use Contao\CoreBundle\Security\ContaoCorePermissions;
use Contao\CoreBundle\Security\DataContainer\ReadAction;
use Contao\CoreBundle\Security\DataContainer\UpdateAction;
use Contao\StringUtil;
use Contao\System;
use Contao\Widget;
use Doctrine\DBAL\ArrayParameterType;
use Doctrine\DBAL\Connection;
use Pdir\ContaoBlockEditorBundle\DataContainer\EditorDataContainer;
use Pdir\ContaoBlockEditorBundle\Security\FieldPolicy;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\Routing\Generator\UrlGeneratorInterface;
use Symfony\Component\Routing\RouterInterface;

/**
 * Builds the read side of the API: element data and the DCA-derived schema. Both
 * only ever contain what the current user may see and edit.
 */
final class ElementInspector
{
    public const TABLE = 'tl_content';
    public const MAX_IDS = 1000;

    /** Parents the editor can link back to. Other parents stay read-only for now. */
    public const SUPPORTED_PTABLES = ['tl_article', 'tl_content'];

    /** Rich-text fields that can be edited in place. */
    private const INLINE_RICH = ['text' => ['field' => 'text', 'selector' => '.rte', 'mode' => 'rich']];

    /** Most elements render their headline as a direct child of the root tag. */
    private const HEADLINE_SELECTOR = ':scope > :is(h1, h2, h3, h4, h5, h6)';

    public function __construct(
        private readonly ContaoFramework $framework,
        private readonly Connection $connection,
        private readonly Security $security,
        private readonly FieldPolicy $fieldPolicy,
        private readonly RouterInterface $router,
    ) {
    }

    /**
     * @param list<int> $ids
     *
     * @return array<int, array<string, mixed>>
     */
    public function getElements(array $ids): array
    {
        $this->loadDca();

        $rows = $this->connection->fetchAllAssociative(
            'SELECT * FROM tl_content WHERE id IN (?) AND ptable IN (?)',
            [$ids, self::SUPPORTED_PTABLES],
            [ArrayParameterType::INTEGER, ArrayParameterType::STRING],
        );

        $elements = [];

        foreach ($rows as $row) {
            if (!$this->security->isGranted(ContaoCorePermissions::DC_PREFIX.self::TABLE, new ReadAction(self::TABLE, $row))) {
                continue;
            }

            $editable = $this->security->isGranted(ContaoCorePermissions::DC_PREFIX.self::TABLE, new UpdateAction(self::TABLE, $row));
            $values = [];

            if ($editable) {
                foreach ($this->getEditableFields($row) as $field) {
                    $values[$field] = $this->toClientValue($field, $row[$field] ?? null);
                }
            }

            $id = (int) $row['id'];

            $elements[$id] = [
                'id' => $id,
                'type' => (string) $row['type'],
                'editable' => $editable,
                'revision' => self::revision($row),
                'values' => (object) $values,
                'classicUrl' => $this->router->generate(
                    'contao_backend',
                    ['do' => 'article', 'table' => self::TABLE, 'act' => 'edit', 'id' => $id],
                    UrlGeneratorInterface::ABSOLUTE_PATH,
                ),
            ];
        }

        return $elements;
    }

    /**
     * @param list<string> $types
     *
     * @return array<string, array<string, mixed>>
     */
    public function getSchema(array $types): array
    {
        $this->loadDca();

        $schema = [];

        foreach ($types as $type) {
            if (!isset($GLOBALS['TL_DCA'][self::TABLE]['palettes'][$type])) {
                continue;
            }

            $row = ['id' => 0, 'type' => $type];
            $dc = new EditorDataContainer(self::TABLE, $row);
            $fields = [];

            foreach ($this->getEditableFields($row) as $field) {
                if ($definition = $this->describeField($field, $dc)) {
                    $fields[] = $definition;
                }
            }

            $schema[$type] = ['fields' => $fields, 'inline' => self::inlineFields($type, array_column($fields, 'name'))];
        }

        return $schema;
    }

    /**
     * What can be edited in place. Only fields the user may edit are passed in.
     *
     * @param list<string> $fields
     *
     * @return list<array{field: string, selector: string|null, mode: string}>
     */
    public static function inlineFields(string $type, array $fields): array
    {
        $inline = [];

        if (\in_array('headline', $fields, true)) {
            // The "headline" element has no wrapper: its root tag is the headline
            $inline[] = ['field' => 'headline', 'selector' => 'headline' === $type ? null : self::HEADLINE_SELECTOR, 'mode' => 'plain'];
        }

        if (isset(self::INLINE_RICH[$type]) && \in_array(self::INLINE_RICH[$type]['field'], $fields, true)) {
            $inline[] = self::INLINE_RICH[$type];
        }

        return $inline;
    }

    /**
     * Fields the current user may edit for this record: part of the record's active
     * palette, supported by the policy and not excluded for the user.
     *
     * @param array<string, mixed> $row
     *
     * @return list<string>
     */
    public function getEditableFields(array $row): array
    {
        $dca = $GLOBALS['TL_DCA'][self::TABLE];
        $type = (string) ($row['type'] ?? '');
        $palette = (string) ($dca['palettes'][$type] ?? '');

        // Include subpalettes, because selector fields can toggle them in the inspector
        foreach ($dca['subpalettes'] ?? [] as $selector => $subpalette) {
            if (str_contains($palette, (string) $selector)) {
                $palette .= ','.$subpalette;
            }
        }

        $fields = [];

        foreach (FieldPolicy::paletteFields($palette) as $field) {
            $config = $dca['fields'][$field] ?? null;

            if (\is_array($config) && $this->fieldPolicy->isSupported($field, $config) && $this->fieldPolicy->canEdit(self::TABLE, $field)) {
                $fields[] = $field;
            }
        }

        return $fields;
    }

    /**
     * An opaque version of the record, used to detect concurrent changes. Unlike
     * tstamp it also catches two saves within the same second.
     *
     * @param array<string, mixed> $row
     */
    public static function revision(array $row): string
    {
        return hash('xxh128', serialize($row));
    }

    public function loadDca(): void
    {
        $this->framework->initialize();

        $controller = $this->framework->getAdapter(Controller::class);
        $controller->loadDataContainer(self::TABLE);
        $system = $this->framework->getAdapter(System::class);
        // Widgets take their error messages from the default language file
        $system->loadLanguageFile('default');
        $system->loadLanguageFile(self::TABLE);
    }

    private function toClientValue(string $field, mixed $value): mixed
    {
        $config = $GLOBALS['TL_DCA'][self::TABLE]['fields'][$field];
        $value = StringUtil::deserialize($value);

        if (!empty($config['eval']['basicEntities'])) {
            $value = StringUtil::convertBasicEntities($value);
        }

        return $value;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function describeField(string $field, EditorDataContainer $dc): array|null
    {
        $config = $GLOBALS['TL_DCA'][self::TABLE]['fields'][$field];

        try {
            $attributes = Widget::getAttributesFromDca($config, $field, null, $field, self::TABLE, $dc);
        } catch (\Throwable) {
            // Option callbacks may rely on a real record: such a field stays classic-only
            return null;
        }

        $eval = $config['eval'] ?? [];

        return [
            'name' => $field,
            'label' => (string) $attributes['label'],
            'description' => (string) ($attributes['description'] ?? ''),
            'input' => $config['inputType'],
            'rich' => isset($eval['rte']),
            'multiple' => !empty($eval['multiple']),
            'mandatory' => !empty($eval['mandatory']),
            'maxlength' => $eval['maxlength'] ?? null,
            'size' => (int) ($eval['size'] ?? 1),
            'options' => array_map(
                static fn (array $option): array => [
                    'value' => (string) ($option['value'] ?? ''),
                    'label' => (string) ($option['label'] ?? ''),
                ],
                array_values(array_filter($attributes['options'] ?? [], static fn ($option): bool => \is_array($option) && !isset($option['group']))),
            ),
            'unitOptions' => 'inputUnit' === $config['inputType'] ? array_map(strval(...), $config['options'] ?? []) : [],
        ];
    }
}
