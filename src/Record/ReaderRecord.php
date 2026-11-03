<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Record;

use Contao\Controller;
use Contao\CoreBundle\Framework\ContaoFramework;
use Contao\CoreBundle\Security\ContaoCorePermissions;
use Contao\CoreBundle\Security\DataContainer\ReadAction;
use Contao\CoreBundle\Security\DataContainer\UpdateAction;
use Contao\StringUtil;
use Contao\System;
use Doctrine\DBAL\Connection;
use Pdir\ContaoBlockEditorBundle\Element\ElementInspector;
use Pdir\ContaoBlockEditorBundle\Security\FieldPolicy;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Generator\UrlGeneratorInterface;
use Symfony\Component\Routing\RouterInterface;

/**
 * Records with fields that the editor changes besides the content elements: the news or
 * event that a reader module shows, whose headline is a field of the record and which the
 * module finds by the last part of the address, and the meta data of the page itself.
 */
final class ReaderRecord
{
    /**
     * The tables: the CSS class of their reader module, the back end module, the model that
     * tells whether the bundle is installed, the fields the editor changes and the field
     * whose value is used when one of them is empty.
     */
    public const READERS = [
        'tl_news' => ['class' => 'mod_newsreader', 'module' => 'news', 'model' => 'Contao\NewsModel', 'label' => 'Nachricht', 'fields' => ['headline', 'subheadline'], 'fallbacks' => []],
        'tl_calendar_events' => ['class' => 'mod_eventreader', 'module' => 'calendar', 'model' => 'Contao\CalendarEventsModel', 'label' => 'Event', 'fields' => ['title'], 'fallbacks' => []],
        // Without a page title, Contao shows the name of the page
        'tl_page' => ['class' => null, 'module' => 'page', 'model' => 'Contao\PageModel', 'label' => 'Seite', 'fields' => ['pageTitle', 'description'], 'fallbacks' => ['pageTitle' => 'title']],
    ];

    public function __construct(
        private readonly ContaoFramework $framework,
        private readonly Connection $connection,
        private readonly Security $security,
        private readonly FieldPolicy $fieldPolicy,
        private readonly RouterInterface $router,
    ) {
    }

    public static function supports(string $table): bool
    {
        return isset(self::READERS[$table]) && class_exists(self::READERS[$table]['model']);
    }

    /**
     * The record of the reader module on a rendered page, like the module finds it.
     *
     * @return array{table: string, id: int, scope: string}|null
     */
    public function find(Request $request, string $html): array|null
    {
        $item = $request->attributes->get('auto_item');

        if (!\is_string($item) || '' === $item) {
            return null;
        }

        foreach (self::READERS as $table => $reader) {
            if (null === $reader['class'] || !self::supports($table) || !preg_match('/class="[^"]*\b'.$reader['class'].'\b/', $html)) {
                continue;
            }

            // The alias is unique; a numeric item may also be the ID
            $ids = $this->connection->fetchFirstColumn(
                'SELECT id FROM '.$table.' WHERE alias = ?'.(ctype_digit($item) ? ' OR id = ?' : ''),
                ctype_digit($item) ? [$item, (int) $item] : [$item],
            );

            if (1 === \count($ids)) {
                return ['table' => $table, 'id' => (int) $ids[0], 'scope' => '.'.$reader['class']];
            }
        }

        return null;
    }

    public function loadDca(string $table): void
    {
        $this->framework->initialize();
        $this->framework->getAdapter(Controller::class)->loadDataContainer($table);

        $system = $this->framework->getAdapter(System::class);
        $system->loadLanguageFile('default');
        $system->loadLanguageFile($table);
    }

    /**
     * @return array<string, mixed>|null
     */
    public function describe(string $table, int $id): array|null
    {
        if (!self::supports($table)) {
            return null;
        }

        $this->loadDca($table);

        $row = $this->connection->fetchAssociative('SELECT * FROM '.$table.' WHERE id = ?', [$id]);

        if (false === $row || !$this->isGranted($table, new ReadAction($table, $row))) {
            return null;
        }

        $editable = $this->isGranted($table, new UpdateAction($table, $row));
        $fields = [];

        foreach ($this->fields($table) as $field) {
            $fallback = self::READERS[$table]['fallbacks'][$field] ?? null;

            $fields[] = [
                'name' => $field,
                'label' => $this->label($table, $field),
                'value' => StringUtil::convertBasicEntities((string) $row[$field]),
                'editable' => $editable && $this->fieldPolicy->canEdit($table, $field),
                'multiline' => 'textarea' === ($GLOBALS['TL_DCA'][$table]['fields'][$field]['inputType'] ?? null),
                'placeholder' => null === $fallback ? '' : StringUtil::convertBasicEntities((string) $row[$fallback]),
            ];
        }

        return [
            'table' => $table,
            'id' => $id,
            'label' => self::READERS[$table]['label'],
            'revision' => ElementInspector::revision($row),
            'fields' => $fields,
            'classicUrl' => $this->classicUrl($table, $id),
        ];
    }

    /**
     * The fields of the reader that exist in this installation and can be edited here.
     *
     * @return list<string>
     */
    public function fields(string $table): array
    {
        return array_values(array_filter(
            self::READERS[$table]['fields'],
            fn (string $field): bool => \is_array($config = $GLOBALS['TL_DCA'][$table]['fields'][$field] ?? null) && $this->fieldPolicy->isSupported($field, $config),
        ));
    }

    public function classicUrl(string $table, int $id, int $referenceType = UrlGeneratorInterface::ABSOLUTE_PATH): string
    {
        return $this->router->generate('contao_backend', ['do' => self::READERS[$table]['module'], 'table' => $table, 'act' => 'edit', 'id' => $id], $referenceType);
    }

    public function isGranted(string $table, ReadAction|UpdateAction $action): bool
    {
        return $this->security->isGranted(ContaoCorePermissions::DC_PREFIX.$table, $action);
    }

    private function label(string $table, string $field): string
    {
        $label = $GLOBALS['TL_DCA'][$table]['fields'][$field]['label'] ?? $GLOBALS['TL_LANG'][$table][$field] ?? null;

        return (string) (\is_array($label) ? ($label[0] ?? $field) : ($label ?? $field));
    }
}
