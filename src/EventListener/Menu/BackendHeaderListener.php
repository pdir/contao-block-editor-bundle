<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\EventListener\Menu;

use Contao\CoreBundle\Event\ContaoCoreEvents;
use Contao\CoreBundle\Event\MenuEvent;
use Contao\CoreBundle\Event\PreviewUrlCreateEvent;
use Contao\CoreBundle\Security\ContaoCorePermissions;
use Knp\Menu\Util\MenuManipulator;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\Routing\RouterInterface;
use Symfony\Contracts\EventDispatcher\EventDispatcherInterface;
use Symfony\Contracts\Translation\TranslatorInterface;

/**
 * Opens the block editor from the header of the back end, next to the preview and for
 * the same page. Without a page in the context, the editor opens the start page.
 */
#[AsEventListener(priority: -49)]
final class BackendHeaderListener
{
    public function __construct(
        private readonly Security $security,
        private readonly RouterInterface $router,
        private readonly RequestStack $requestStack,
        private readonly TranslatorInterface $translator,
        private readonly EventDispatcherInterface $eventDispatcher,
    ) {
    }

    public function __invoke(MenuEvent $event): void
    {
        $tree = $event->getTree();
        $request = $this->requestStack->getCurrentRequest();

        if ('headerMenu' !== $tree->getName() || !$request || !$this->security->isGranted(ContaoCorePermissions::USER_CAN_ACCESS_MODULE, 'article')) {
            return;
        }

        $item = $event->getFactory()
            ->createItem('block_editor')
            ->setLabel('MSC.blockEditor')
            ->setUri($this->router->generate('pdir_block_editor', $this->context($request)))
            ->setLinkAttribute('class', 'icon-block-editor')
            ->setLinkAttribute('title', $this->translator->trans('MSC.blockEditorTitle', [], 'contao_default'))
            ->setLinkAttribute('data-contao--tooltips-target', 'tooltip')
            // The editor is a page of its own: Turbo would load it into the back end and hang
            ->setLinkAttribute('data-turbo', 'false')
            ->setLinkAttribute('data-turbo-prefetch', 'false')
            ->setExtra('translation_domain', 'contao_default')
        ;

        $tree->addChild($item);

        // Right after the preview: the last two items are "submenu" and "burger"
        (new MenuManipulator())->moveToPosition($item, $tree->count() - 3);
    }

    /**
     * The page and the content element the user is working on, as far as known.
     *
     * @return array<string, int>
     */
    public function context(Request $request): array
    {
        $do = (string) $request->query->get('do', '');
        $id = (int) ($request->query->get('id') ?? $request->query->get('pid'));

        if (!\in_array($do, ['page', 'article'], true) || !$id) {
            return [];
        }

        // The same page as the preview, which also resolves articles and content elements
        $event = new PreviewUrlCreateEvent($do, $id);
        $this->eventDispatcher->dispatch($event, ContaoCoreEvents::PREVIEW_URL_CREATE);
        parse_str((string) $event->getQuery(), $query);

        $context = ['id' => (int) ($query['page'] ?? 0)];

        if (!$context['id']) {
            return [];
        }

        if ('tl_content' === $request->query->get('table') && \in_array($request->query->get('act'), ['edit', 'show'], true)) {
            $context['element'] = (int) $request->query->get('id');
        }

        return $context;
    }
}
