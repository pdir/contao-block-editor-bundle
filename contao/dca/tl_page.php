<?php

declare(strict_types=1);

// Entry point: an operation in the page tree opens the page in the block editor.
// Availability per page is enforced again by EditorController.
$GLOBALS['TL_DCA']['tl_page']['list']['operations']['block_editor'] = [
    'route' => 'pdir_block_editor',
    'icon' => 'bundles/contaoblockeditor/icon.svg',
    // The editor is a page of its own: Turbo would load it into the back end and hang
    'attributes' => 'data-turbo="false" data-turbo-prefetch="false"',
];
