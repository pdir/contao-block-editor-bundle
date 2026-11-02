<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\Tests\EventListener;

use Contao\CoreBundle\Event\ContaoCoreEvents;
use Contao\CoreBundle\Event\PreviewUrlCreateEvent;
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
