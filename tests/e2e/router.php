<?php
// Stands for an application next to Contao that sends visitors to a page of the website
if (str_starts_with(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH), '/extern/')) { header('Location: http://127.0.0.1:8765/geheim.html', true, 302); return; }
$p = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (str_starts_with($p, '/preview.php')) { $_SERVER['SCRIPT_NAME']='/preview.php'; $_SERVER['SCRIPT_FILENAME']=__DIR__.'/public/preview.php'; $_SERVER['PHP_SELF']=$p; chdir('public'); require __DIR__.'/public/preview.php'; return; }
if ($p !== '/' && is_file(__DIR__.'/public'.$p)) return false;
$_SERVER['SCRIPT_NAME']='/index.php'; $_SERVER['SCRIPT_FILENAME']=__DIR__.'/public/index.php'; chdir('public'); require __DIR__.'/public/index.php';
