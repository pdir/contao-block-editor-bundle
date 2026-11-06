<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\EventListener;

use Contao\CoreBundle\Event\ContaoCoreEvents;
use Contao\CoreBundle\Event\PreviewUrlCreateEvent;
use Contao\CoreBundle\Event\MenuEvent;
use Knp\Menu\MenuFactory;
use Pdir\ContaoBlockEditorBundle\EventListener\Menu\BackendHeaderListener;
use PHPUnit\Framework\TestCase;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\EventDispatcher\EventDispatcher;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\Routing\RouterInterface;
use Symfony\Contracts\Translation\TranslatorInterface;

final class BackendHeaderListenerTest extends TestCase
{
    public function testPageOfThePreviewIsOpened(): void
    {
        self::assertSame(['id' => 7], $this->listener(7)->context(new Request(['do' => 'article', 'table' => 'tl_content', 'id' => 3])));
    }

    public function testEditedContentElementIsShown(): void
    {
        self::assertSame(['id' => 7, 'element' => 12], $this->listener(7)->context(new Request(['do' => 'article', 'table' => 'tl_content', 'act' => 'edit', 'id' => 12])));
    }

    public function testWithoutAPageTheStartPageIsOpened(): void
    {
        self::assertSame([], $this->listener(null)->context(new Request(['do' => 'article', 'id' => 3])));
        self::assertSame([], $this->listener(7)->context(new Request(['do' => 'files', 'id' => 3])));
        self::assertSame([], $this->listener(7)->context(new Request()));
    }

    public function testLinkLeavesTheBackEndWithoutTurbo(): void
    {
        $security = $this->createStub(Security::class);
        $security->method('isGranted')->willReturn(true);

        $router = $this->createStub(RouterInterface::class);
        $router->method('generate')->willReturn('/contao/block-editor');

        $requestStack = new RequestStack();
        $requestStack->push(new Request(['do' => 'page']));

        $factory = new MenuFactory();
        $tree = $factory->createItem('headerMenu');
        $tree->addChild('preview');
        $tree->addChild('submenu');
        $tree->addChild('burger');

        $listener = new BackendHeaderListener($security, $router, $requestStack, $this->createStub(TranslatorInterface::class), new EventDispatcher());
        $listener(new MenuEvent($factory, $tree));

        $link = $tree->getChild('block_editor');

        self::assertNotNull($link);
        self::assertSame(['preview', 'block_editor', 'submenu', 'burger'], array_keys($tree->getChildren()));
        self::assertSame('false', $link->getLinkAttribute('data-turbo'));
        self::assertSame('false', $link->getLinkAttribute('data-turbo-prefetch'));
    }

    private function listener(int|null $page): BackendHeaderListener
    {
        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(ContaoCoreEvents::PREVIEW_URL_CREATE, static function (PreviewUrlCreateEvent $event) use ($page): void {
            if ($page) {
                $event->setQuery('page='.$page);
            }
        });

        return new BackendHeaderListener(
            $this->createStub(Security::class),
            $this->createStub(RouterInterface::class),
            new RequestStack(),
            $this->createStub(TranslatorInterface::class),
            $dispatcher,
        );
    }
}
