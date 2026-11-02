<?php

declare(strict_types=1);

use Contao\System;

// The icon of the block editor in the header of the back end
$request = System::getContainer()->get('request_stack')->getCurrentRequest();

if ($request && System::getContainer()->get('contao.routing.scope_matcher')->isBackendRequest($request)) {
    $GLOBALS['TL_CSS'][] = 'bundles/contaoblockeditor/backend.css|static';
}
