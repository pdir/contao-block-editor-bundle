<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Page;

use Contao\Config;
use Contao\Controller;
use Contao\CoreBundle\Framework\ContaoFramework;
use Contao\CoreBundle\Security\ContaoCorePermissions;
use Contao\CoreBundle\Security\DataContainer\ReadAction;
use Contao\CoreBundle\Security\DataContainer\UpdateAction;
use Contao\Date;
use Contao\PageModel;
use Contao\StringUtil;
use Contao\System;
use Doctrine\DBAL\Connection;
use Pdir\ContaoBlockEditorBundle\Element\ElementInspector;
use Pdir\ContaoBlockEditorBundle\Security\FieldPolicy;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Exception\ExceptionInterface as RoutingException;
use Symfony\Component\Routing\Generator\UrlGeneratorInterface;
use Symfony\Component\Routing\Matcher\RequestMatcherInterface;
use Symfony\Component\Routing\RouterInterface;

/**
 * The pages behind the links of a navigation. A link only carries its address, so
 * Contao's own router tells which page it is. Only pages the user may see are returned.
 */
final class PageInspector
{
    public const TABLE = 'tl_page';
    public const MAX_URLS = 200;
    public const TITLE = 'title';

    /** What the inspector shows about a page besides its name. */
    private const DETAILS = ['type', 'alias', 'pageTitle', 'description', 'robots', 'hide', 'published', 'start', 'stop', 'protected'];

    public function __construct(
        private readonly ContaoFramework $framework,
        private readonly Connection $connection,
        private readonly Security $security,
        private readonly FieldPolicy $fieldPolicy,
        private readonly RouterInterface $router,
    ) {
    }

    public function loadDca(): void
    {
        $this->framework->initialize();
        $this->framework->getAdapter(Controller::class)->loadDataContainer(self::TABLE);

        $system = $this->framework->getAdapter(System::class);
        $system->loadLanguageFile('default');
        $system->loadLanguageFile(self::TABLE);
    }

    /**
     * @param list<string> $urls
     *
     * @return array<string, array<string, mixed>> The pages by the address they were asked for
     */
    public function resolve(array $urls, Request $request): array
    {
        $this->loadDca();

        $ids = [];

        foreach ($urls as $url) {
            if ($id = $this->findPageId($url, $request)) {
                $ids[$url] = $id;
            }
        }

        $pages = [];

        foreach (array_unique($ids) as $id) {
            $pages[$id] = $this->describe($id);
        }

        return array_filter(array_map(static fn (int $id): array|null => $pages[$id], $ids));
    }

    /**
     * @return array<string, mixed>|null
     */
    public function describe(int $id): array|null
    {
        $row = $this->connection->fetchAssociative('SELECT * FROM tl_page WHERE id = ?', [$id]);

        if (false === $row || !$this->security->isGranted(ContaoCorePermissions::DC_PREFIX.self::TABLE, new ReadAction(self::TABLE, $row))) {
            return null;
        }

        return [
            'id' => $id,
            'revision' => ElementInspector::revision($row),
            'title' => StringUtil::convertBasicEntities((string) $row[self::TITLE]),
            'label' => $this->label(self::TITLE),
            'editable' => $this->canEditTitle($row),
            'details' => $this->details($row),
            'classicUrl' => $this->router->generate('contao_backend', ['do' => 'page', 'act' => 'edit', 'id' => $id], UrlGeneratorInterface::ABSOLUTE_PATH),
        ];
    }

    /**
     * @param array<string, mixed> $row
     */
    public function canEditTitle(array $row): bool
    {
        return $this->security->isGranted(ContaoCorePermissions::DC_PREFIX.self::TABLE, new UpdateAction(self::TABLE, $row))
            && $this->fieldPolicy->canEdit(self::TABLE, self::TITLE);
    }

    private function findPageId(string $url, Request $request): int|null
    {
        $parts = parse_url($url);

        // Only pages of the website the editor runs on
        if (!\is_array($parts) || strtolower($parts['host'] ?? '') !== strtolower($request->getHost()) || !$this->router instanceof RequestMatcherInterface) {
            return null;
        }

        try {
            $parameters = $this->router->matchRequest(Request::create($request->getSchemeAndHttpHost().($parts['path'] ?? '/')));
        } catch (RoutingException) {
            return null;
        }

        $page = $parameters['pageModel'] ?? null;

        if (!$page instanceof PageModel) {
            return null;
        }

        // A root page stands for its start page, which the link leads to
        if ('root' === $page->type) {
            $page = $this->framework->getAdapter(PageModel::class)->findFirstPublishedRegularByPid($page->id);
        }

        return $page instanceof PageModel ? (int) $page->id : null;
    }

    /**
     * @param array<string, mixed> $row
     *
     * @return list<array{label: string, value: string}>
     */
    private function details(array $row): array
    {
        $details = [];

        foreach (self::DETAILS as $field) {
            $config = $GLOBALS['TL_DCA'][self::TABLE]['fields'][$field] ?? null;

            // Fields hidden from the user in the back end stay hidden here as well
            if (!\is_array($config) || !$this->fieldPolicy->canEdit(self::TABLE, $field)) {
                continue;
            }

            $value = $this->format($field, $config, $row[$field] ?? null);

            if ('' !== $value) {
                $details[] = ['label' => $this->label($field), 'value' => $value];
            }
        }

        return $details;
    }

    /**
     * @param array<string, mixed> $config
     */
    private function format(string $field, array $config, mixed $value): string
    {
        if ('checkbox' === ($config['inputType'] ?? null) && empty($config['eval']['multiple'])) {
            return (string) ($GLOBALS['TL_LANG']['MSC'][$value ? 'yes' : 'no'] ?? ($value ? 'ja' : 'nein'));
        }

        if ('' === (string) $value) {
            return '';
        }

        if ('datim' === ($config['eval']['rgxp'] ?? null)) {
            return Date::parse(Config::get('datimFormat'), (int) $value);
        }

        $reference = $config['reference'][$value] ?? null;

        if (null !== $reference) {
            return (string) (\is_array($reference) ? $reference[0] : $reference);
        }

        return StringUtil::decodeEntities((string) $value);
    }

    private function label(string $field): string
    {
        $label = $GLOBALS['TL_DCA'][self::TABLE]['fields'][$field]['label'] ?? $GLOBALS['TL_LANG'][self::TABLE][$field] ?? null;

        return (string) (\is_array($label) ? ($label[0] ?? $field) : ($label ?? $field));
    }
}
