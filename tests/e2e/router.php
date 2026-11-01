<?php
$p = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (str_starts_with($p, '/preview.php')) { $_SERVER['SCRIPT_NAME']='/preview.php'; $_SERVER['SCRIPT_FILENAME']=__DIR__.'/public/preview.php'; $_SERVER['PHP_SELF']=$p; chdir('public'); require __DIR__.'/public/preview.php'; return; }
if ($p !== '/' && is_file(__DIR__.'/public'.$p)) return false;
$_SERVER['SCRIPT_NAME']='/index.php'; $_SERVER['SCRIPT_FILENAME']=__DIR__.'/public/index.php'; chdir('public'); require __DIR__.'/public/index.php';
