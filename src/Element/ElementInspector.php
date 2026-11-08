<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Element;

use Contao\Controller;
use Contao\CoreBundle\Framework\ContaoFramework;
use Contao\CoreBundle\Security\ContaoCorePermissions;
use Contao\CoreBundle\Security\DataContainer\ReadAction;
use Contao\CoreBundle\Security\DataContainer\DeleteAction;
use Contao\CoreBundle\Security\DataContainer\UpdateAction;
use Contao\StringUtil;
use Contao\System;
use Contao\Widget;
use Doctrine\DBAL\ArrayParameterType;
use Doctrine\DBAL\Connection;
use Pdir\ContaoBlockEditorBundle\DataContainer\CallbackInvoker;
use Pdir\ContaoBlockEditorBundle\DataContainer\DateValue;
use Pdir\ContaoBlockEditorBundle\DataContainer\EditContext;
use Pdir\ContaoBlockEditorBundle\DataContainer\EditorDataContainer;
use Pdir\ContaoBlockEditorBundle\DataContainer\VirtualFields;
use Pdir\ContaoBlockEditorBundle\Security\FieldPolicy;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpFoundation\RequestStack;
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

    /**
     * Where content elements can live, with the back end module that edits them. Contao's
     * voter for the parent decides about the permissions: news and events are only supported
     * if their bundle with its voter is installed, so no check can go missing. Other parents
     * stay read-only.
     */
    private const PARENTS = [
        'tl_article' => ['module' => 'article', 'voter' => null],
        'tl_news' => ['module' => 'news', 'voter' => 'Contao\\NewsBundle\\Security\\Voter\\NewsContentVoter'],
        'tl_calendar_events' => ['module' => 'calendar', 'voter' => 'Contao\\CalendarBundle\\Security\\Voter\\CalendarContentVoter'],
    ];

    /** Elements nested in elements, e.g. in an accordion. */
    private const MAX_DEPTH = 32;

    /** Rich-text fields that can be edited in place. */
    private const INLINE_RICH = ['text' => ['field' => 'text', 'selector' => '.rte', 'mode' => 'rich']];

    /** Most elements render their headline as a direct child of the root tag. */
    private const HEADLINE_SELECTOR = ':scope > :is(h1, h2, h3, h4, h5, h6)';

    /** The headline of an accordion section belongs to the element inside of the section. */
    private const SECTION_FIELD = 'sectionHeadline';

    /** @var array<int, string> */
    private array $parentTypes = [];

    public function __construct(
        private readonly ContaoFramework $framework,
        private readonly Connection $connection,
        private readonly Security $security,
        private readonly FieldPolicy $fieldPolicy,
        private readonly RouterInterface $router,
        private readonly FileReferences|null $files = null,
        private readonly RequestStack|null $requestStack = null,
    ) {
    }

    /**
     * Runs the record's onload callbacks for what is done inside, as the back end does for its
     * edit form, and restores the DCA afterwards. Other bundles add their fields there.
     *
     * @template T
     *
     * @param array<string, mixed> $row
     * @param \Closure(EditorDataContainer): T $inside
     *
     * @return T
     */
    private function asInEditForm(array $row, \Closure $inside): mixed
    {
        $dc = new EditorDataContainer(self::TABLE, $row);

        return EditContext::forRecord(self::TABLE, $dc, $this->requestStack?->getCurrentRequest(), static fn (): mixed => $inside($dc));
    }

    /**
     * The configuration of a field after its load callbacks, which adjust it to the record: the
     * core allows other file types for the image of a text than for a download, for example.
     * The global DCA stays as it was, so one record does not affect the next.
     *
     * @return array<string, mixed>
     */
    public static function configForRecord(string $table, string $field, EditorDataContainer $dc, mixed $value = null): array
    {
        $original = $GLOBALS['TL_DCA'][$table]['fields'][$field];

        try {
            $dc->setField($field);
            CallbackInvoker::invokeAll($original['load_callback'] ?? null, $value, $dc);

            return $GLOBALS['TL_DCA'][$table]['fields'][$field];
        } catch (\Throwable) {
            return $original;
        } finally {
            $GLOBALS['TL_DCA'][$table]['fields'][$field] = $original;
        }
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
            [$ids, self::supportedPtables()],
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
                $values = $this->asInEditForm($row, function () use ($row): array {
                    $record = VirtualFields::expand($row, self::TABLE);
                    $values = [];

                    foreach ($this->getEditableFields($row) as $field) {
                        $values[$field] = $this->toClientValue($field, $record[$field] ?? null);
                    }

                    return $values;
                });
            }

            $id = (int) $row['id'];

            $elements[$id] = [
                'id' => $id,
                'type' => (string) $row['type'],
                'editable' => $editable,
                'deletable' => !($GLOBALS['TL_DCA'][self::TABLE]['config']['notDeletable'] ?? false) && $this->security->isGranted(ContaoCorePermissions::DC_PREFIX.self::TABLE, new DeleteAction(self::TABLE, $row)),
                'revision' => self::revision($row),
                'values' => (object) $values,
                'classicUrl' => $this->classicUrl($row),
            ];
        }

        return $elements;
    }

    /**
     * The fields of each type. Fields that other bundles add in their onload callbacks depend on
     * a record; an element of the type from the page stands for its type, so that they are
     * described. The inspector only shows the fields an element has values for.
     *
     * @param list<string> $types
     * @param list<int>    $ids   Elements of the page
     *
     * @return array<string, array<string, mixed>>
     */
    public function getSchema(array $types, array $ids = []): array
    {
        $this->loadDca();

        $examples = $this->examples($types, $ids);
        $schema = [];

        foreach ($types as $type) {
            if (!isset($GLOBALS['TL_DCA'][self::TABLE]['palettes'][$type])) {
                continue;
            }

            $schema[$type] = $this->asInEditForm($examples[$type] ?? ['id' => 0, 'type' => $type], function (EditorDataContainer $dc) use ($type): array {
                $fields = [];

                // The section headline is described on its own below
                foreach ($this->getEditableFields(['type' => $type]) as $field) {
                    if ($definition = $this->describeField($field, $dc)) {
                        $fields[] = $definition;
                    }
                }

                $schema = [
                    // The name editors know from the back end, which bundles provide for their own types
                    'label' => self::typeLabel($type),
                    'fields' => $fields,
                    'inline' => self::inlineFields($type, array_column($fields, 'name')),
                ];

                // Whether it applies depends on the parent of the record, not on the type
                $config = $GLOBALS['TL_DCA'][self::TABLE]['fields'][self::SECTION_FIELD] ?? null;

                if (\is_array($config) && $this->fieldPolicy->isSupported(self::SECTION_FIELD, $config) && $this->fieldPolicy->canEdit(self::TABLE, self::SECTION_FIELD) && ($section = $this->describeField(self::SECTION_FIELD, $dc))) {
                    $schema['section'] = $section;
                }

                return $schema;
            });
        }

        return $schema;
    }

    /**
     * One element of each type that the user may edit.
     *
     * @param list<string> $types
     * @param list<int>    $ids
     *
     * @return array<string, array<string, mixed>>
     */
    private function examples(array $types, array $ids): array
    {
        if (!$ids || !$types) {
            return [];
        }

        $rows = $this->connection->fetchAllAssociative(
            'SELECT * FROM tl_content WHERE id IN (?) AND type IN (?) AND ptable IN (?) ORDER BY id',
            [\array_slice($ids, 0, self::MAX_IDS), $types, self::supportedPtables()],
            [ArrayParameterType::INTEGER, ArrayParameterType::STRING, ArrayParameterType::STRING],
        );

        $examples = [];

        foreach ($rows as $row) {
            if (!isset($examples[$row['type']]) && $this->security->isGranted(ContaoCorePermissions::DC_PREFIX.self::TABLE, new UpdateAction(self::TABLE, $row))) {
                $examples[(string) $row['type']] = $row;
            }
        }

        return $examples;
    }

    public static function typeLabel(string $type): string
    {
        $label = $GLOBALS['TL_LANG']['CTE'][$type] ?? null;
        $label = \is_array($label) ? ($label[0] ?? null) : $label;

        return \is_string($label) && '' !== trim($label) ? $label : $type;
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

        // The cells of the core's table, each edited where it is shown
        if ('table' === $type && \in_array('tableitems', $fields, true)) {
            $inline[] = ['field' => 'tableitems', 'selector' => 'table', 'mode' => 'table'];
        }

        // The terms and details of a description list, each edited where it is shown
        if ('description_list' === $type && \in_array('data', $fields, true)) {
            $inline[] = ['field' => 'data', 'selector' => 'dl', 'mode' => 'terms'];
        }

        // The items of the core's list, each edited where it is shown
        if ('list' === $type && \in_array('listitems', $fields, true)) {
            $inline[] = ['field' => 'listitems', 'selector' => 'ul, ol', 'mode' => 'list'];
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
        $paletteFields = FieldPolicy::paletteFields($palette);

        // Core adds it in an onpalette callback (AccordionListener), which only the back end runs
        if ($this->isInAccordion($row)) {
            $paletteFields[] = self::SECTION_FIELD;
        }

        foreach ($paletteFields as $field) {
            $config = $dca['fields'][$field] ?? null;

            if (\is_array($config) && $this->fieldPolicy->isSupported($field, $config) && $this->fieldPolicy->canEdit(self::TABLE, $field)) {
                $fields[] = $field;
            }
        }

        return $fields;
    }

    /**
     * @param array<string, mixed> $row
     */
    private function isInAccordion(array $row): bool
    {
        if ('tl_content' !== ($row['ptable'] ?? null) || !($pid = (int) ($row['pid'] ?? 0))) {
            return false;
        }

        return 'accordion' === ($this->parentTypes[$pid] ??= (string) $this->connection->fetchOne('SELECT type FROM tl_content WHERE id = ?', [$pid]));
    }

    /**
     * An opaque version of the record, used to detect concurrent changes. Unlike
     * tstamp it also catches two saves within the same second.
     *
     * @param array<string, mixed> $row
     */
    /**
     * @return list<string>
     */
    public static function supportedPtables(): array
    {
        $ptables = ['tl_content'];

        foreach (self::PARENTS as $table => ['voter' => $voter]) {
            if (null === $voter || class_exists($voter)) {
                $ptables[] = $table;
            }
        }

        return $ptables;
    }

    /**
     * The element in the back end: news elements are edited in the news module, for example.
     *
     * @param array<string, mixed> $row
     */
    public function classicUrl(array $row, int $referenceType = UrlGeneratorInterface::ABSOLUTE_PATH): string
    {
        return $this->router->generate(
            'contao_backend',
            ['do' => $this->backendModule($row), 'table' => self::TABLE, 'act' => 'edit', 'id' => (int) $row['id']],
            $referenceType,
        );
    }

    /**
     * @param array<string, mixed> $row
     */
    private function backendModule(array $row): string
    {
        $ptable = (string) ($row['ptable'] ?? '');
        $pid = (int) ($row['pid'] ?? 0);

        // Nested elements belong to the module of the outermost one
        for ($depth = 0; 'tl_content' === $ptable && $depth < self::MAX_DEPTH; ++$depth) {
            $parent = $this->connection->fetchAssociative('SELECT pid, ptable FROM tl_content WHERE id = ?', [$pid]);

            if (false === $parent) {
                break;
            }

            [$ptable, $pid] = [(string) $parent['ptable'], (int) $parent['pid']];
        }

        return self::PARENTS[$ptable]['module'] ?? 'article';
    }

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

    /**
     * Options with groups, as the image size widget gets them: the sizes of each theme, then the
     * resize modes.
     *
     * @return list<array{label: string, options: list<array{value: string, label: string}>}>
     */
    private static function optionGroups(mixed $options): array
    {
        $groups = [];
        $loose = [];
        $option = static fn (array $option): array => ['value' => (string) ($option['value'] ?? ''), 'label' => (string) ($option['label'] ?? '')];

        foreach (\is_array($options) ? $options : [] as $key => $entry) {
            if (!\is_array($entry)) {
                continue;
            }

            if (\array_key_exists('value', $entry)) {
                $loose[] = $option($entry);
            } else {
                $groups[] = ['label' => (string) $key, 'options' => array_values(array_map($option, array_filter($entry, \is_array(...))))];
            }
        }

        return $loose ? [['label' => '', 'options' => $loose], ...$groups] : $groups;
    }

    private static function columnLabel(mixed $label, string $name): string
    {
        return (string) (\is_array($label) ? ($label[0] ?? $name) : ($label ?? $name));
    }

    /**
     * Allowed file types as a list; the core also names a container parameter here.
     *
     * @return list<string>
     */
    private static function extensions(mixed $extensions): array
    {
        if (\is_string($extensions) && 1 === preg_match('/^%([^%]+)%$/', $extensions, $matches)) {
            try {
                $extensions = System::getContainer()->getParameter($matches[1]);
            } catch (\Throwable) {
                return [];
            }
        }

        $list = \is_array($extensions) ? $extensions : explode(',', (string) $extensions);

        return array_values(array_filter(array_map(static fn (mixed $extension): string => strtolower(trim((string) $extension)), $list)));
    }

    private function toClientValue(string $field, mixed $value): mixed
    {
        $config = $GLOBALS['TL_DCA'][self::TABLE]['fields'][$field];
        $value = StringUtil::deserialize($value);

        if (DateValue::isDate($config)) {
            return DateValue::toInput($value, (string) $config['eval']['rgxp']);
        }

        // The chosen CSS classes, by style
        if (StyleGroups::INPUT_TYPE === ($config['inputType'] ?? null)) {
            return \is_array($value) ? array_values(array_map(strval(...), array_filter($value, \is_scalar(...)))) : [];
        }

        if (!empty($config['eval']['basicEntities'])) {
            $value = StringUtil::convertBasicEntities($value);
        }

        // Rows and cells as lists, also if the keys of the stored array have gaps
        if ('tableWizard' === ($config['inputType'] ?? null)) {
            $value = \is_array($value) ? array_values(array_map(
                static fn (mixed $row): array => array_values(array_map(static fn (mixed $cell): string => \is_scalar($cell) ? (string) $cell : '', \is_array($row) ? $row : [$row])),
                $value,
            )) : [];
        }

        // The files with their names and previews: the record only holds binary UUIDs
        if ('fileTree' === ($config['inputType'] ?? null)) {
            return $this->files?->describe($value) ?? [];
        }

        if ('imageSize' === ($config['inputType'] ?? null)) {
            $value = \is_array($value) ? $value : [];

            return [(string) ($value[0] ?? ''), (string) ($value[1] ?? ''), (string) ($value[2] ?? '')];
        }

        // Rows with exactly the columns of the field, as strings
        if ('rowWizard' === ($config['inputType'] ?? null)) {
            $names = array_keys($config['fields'] ?? []);

            return \is_array($value) ? array_values(array_map(
                static fn (mixed $row): array => array_combine($names, array_map(static fn (string $name): string => \is_array($row) && \is_scalar($row[$name] ?? null) ? (string) $row[$name] : '', $names)),
                array_filter($value, \is_array(...)),
            )) : [];
        }

        if ('listWizard' === ($config['inputType'] ?? null)) {
            $value = \is_array($value) ? array_values(array_map(static fn (mixed $item): string => \is_scalar($item) ? (string) $item : '', $value)) : [];
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
        $definition = [];

        if ('fileTree' === $config['inputType']) {
            $eval = self::configForRecord(self::TABLE, $field, $dc)['eval'] ?? [];
            $definition['files'] = [
                'multiple' => !empty($eval['multiple']),
                'filesOnly' => !empty($eval['filesOnly']),
                'folders' => false === ($eval['files'] ?? null) || (empty($eval['filesOnly']) && empty($eval['files'])),
                'extensions' => self::extensions($eval['extensions'] ?? ''),
                'path' => (string) ($eval['path'] ?? ''),
                'sortable' => !empty($eval['isSortable']),
            ];
        }

        if ('rowWizard' === $config['inputType']) {
            $definition['columns'] = array_map(
                static fn (string $name, array $column): array => ['name' => $name, 'label' => self::columnLabel($column['label'] ?? null, $name)],
                array_keys($config['fields']),
                array_values($config['fields']),
            );
        }

        if ('imageSize' === $config['inputType']) {
            $definition['sizes'] = self::optionGroups($attributes['options'] ?? []);
        }

        if (DateValue::isDate($config)) {
            $definition['date'] = (string) $eval['rgxp'];
        }

        if (StyleGroups::INPUT_TYPE === $config['inputType']) {
            $groups = StyleGroups::describe(array_values(array_filter($attributes['options'] ?? [], \is_array(...))));

            // Nothing to choose for the record, as in the back end
            if (!$groups) {
                return null;
            }

            $definition['styles'] = $groups;
        }

        return $definition + [
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
