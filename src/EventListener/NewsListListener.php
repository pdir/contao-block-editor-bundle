<?php

declare(strict_types=1);

namespace Pdir\ContaoBlockEditorBundle\EventListener;

use Contao\CoreBundle\DependencyInjection\Attribute\AsHook;
use Contao\FrontendTemplate;
use Contao\Module;

/**
 * Marks each news of a list in the editor frame, so that its headline and teaser can be
 * edited where the list shows them. The class is the only part of the root tag that all
 * news templates take from outside. The news of a reader page is found by its address.
 */
final class NewsListListener
{
    public const CLASS_PREFIX = 'cbe-news-';

    public function __construct(private readonly EditorFrameListener $frame)
    {
    }

    /**
     * @param array<string, mixed> $row
     */
    #[AsHook('parseArticles')]
    public function markNews(FrontendTemplate $template, array $row, Module $module): void
    {
        $id = (int) ($row['id'] ?? 0);

        if ($id < 1 || 'newsreader' === $module->type || !$this->frame->isEditorRequest()) {
            return;
        }

        // The ID is an integer, so no escaping is required
        $template->class = (string) $template->class.' '.self::CLASS_PREFIX.$id;
    }
}
