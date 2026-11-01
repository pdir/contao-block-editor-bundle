DELETE FROM tl_theme;
INSERT INTO tl_theme (id,tstamp,name) VALUES (1,1,'T');
INSERT INTO tl_layout (id,pid,tstamp,name,`rows`,cols,modules,template,viewport) VALUES (1,1,1,'L','1rw','1cl','a:1:{i:0;a:3:{s:3:"mod";s:1:"0";s:3:"col";s:4:"main";s:6:"enable";s:1:"1";}}','fe_page','width=device-width');
INSERT INTO tl_page (id,pid,sorting,tstamp,title,alias,type,language,fallback,includeLayout,layout,published,dns,urlPrefix,urlSuffix,robots) VALUES
 (1,0,128,1,'Root','root','root','de',1,1,1,1,'','','.html','index,follow'),
 (2,1,128,1,'Start','index','regular','de',0,0,0,1,'','','','index,follow'),
 (3,1,256,1,'Geheim','geheim','regular','de',0,0,0,1,'','','','index,follow');
INSERT INTO tl_article (id,pid,sorting,tstamp,title,alias,author,inColumn,published) VALUES (1,2,128,1,'A1','a1',1,'main',1),(2,3,128,1,'A2','a2',1,'main',1);
INSERT INTO tl_content (id,pid,ptable,sorting,tstamp,type,headline,text,unfilteredHtml,cssID) VALUES
 (10,1,'tl_article',128,1,'text','a:2:{s:5:"value";s:0:"";s:4:"unit";s:2:"h2";}','<p>Hallo <strong>Welt</strong></p>','','a:2:{i:0;s:0:"";i:1;s:0:"";}'),
 (11,1,'tl_article',256,1,'headline','a:2:{s:5:"value";s:12:"Ueberschrift";s:4:"unit";s:2:"h2";}',NULL,'','a:2:{i:0;s:0:"";i:1;s:0:"";}'),
 (12,1,'tl_article',384,1,'text','a:2:{s:5:"value";s:0:"";s:4:"unit";s:2:"h2";}','<table><tr><td>Tabelle</td></tr></table>','','a:2:{i:0;s:0:"";i:1;s:0:"";}'),
 (13,1,'tl_article',512,1,'html','a:2:{s:5:"value";s:0:"";s:4:"unit";s:2:"h2";}',NULL,'<div>raw</div>','a:2:{i:0;s:0:"";i:1;s:0:"";}'),
 (20,2,'tl_article',128,1,'text','a:2:{s:5:"value";s:0:"";s:4:"unit";s:2:"h2";}','<p>Fremde Seite</p>','','a:2:{i:0;s:0:"";i:1;s:0:"";}');
INSERT INTO tl_user (tstamp,username,name,email,language,password,admin,disable,inherit,modules,elements,pagemounts,alpty,fields,cud,fop,dateAdded) VALUES
 (1,'editor','Editor','e@example.com','de','$2y$12$6kFnI3Vv9eza.e894jPlveHseizth7RqIyufoL1PKhLZSekHuFmfm',0,0,'custom','a:2:{i:0;s:7:"article";i:1;s:4:"page";}','a:2:{i:0;s:4:"text";i:1;s:8:"headline";}','a:1:{i:0;i:2;}','a:1:{i:0;s:7:"regular";}','a:3:{i:0;s:16:"tl_content::type";i:1;s:20:"tl_content::headline";i:2;s:16:"tl_content::text";}','a:1:{i:0;s:18:"tl_content::update";}','a:0:{}',1);
UPDATE tl_user SET pwChange=0;
UPDATE tl_page SET includeChmod=1,cuser=(SELECT id FROM tl_user WHERE username='editor'),cgroup=0,chmod='a:12:{i:0;s:2:"u1";i:1;s:2:"u2";i:2;s:2:"u3";i:3;s:2:"u4";i:4;s:2:"u5";i:5;s:2:"u6";i:6;s:2:"g4";i:7;s:2:"g5";i:8;s:2:"g6";i:9;s:2:"w4";i:10;s:2:"w5";i:11;s:2:"w6";}' WHERE id=2;
INSERT INTO tl_user_group (id,tstamp,name,alexf) VALUES (1,1,'Redaktion','a:3:{i:0;s:16:"tl_content::type";i:1;s:20:"tl_content::headline";i:2;s:16:"tl_content::text";}');
UPDATE tl_user SET `fields`=NULL, inherit='extend', `groups`='a:1:{i:0;s:1:"1";}' WHERE username='editor';
UPDATE tl_page SET useSSL=0;
INSERT INTO tl_content (id,pid,ptable,sorting,tstamp,type,headline,text,unfilteredHtml,cssID) VALUES
 (14,1,'tl_article',640,1,'text','a:2:{s:5:"value";s:0:"";s:4:"unit";s:2:"h2";}','<p>Support: {{email::support@pdir.dev}} Ende</p>','','a:2:{i:0;s:0:"";i:1;s:0:"";}'),
 (15,1,'tl_article',768,1,'headline','a:2:{s:5:"value";s:21:"Seite {{page::title}}";s:4:"unit";s:2:"h2";}',NULL,'','a:2:{i:0;s:0:"";i:1;s:0:"";}');
INSERT INTO tl_content (id,pid,ptable,sorting,tstamp,type,headline,text,listitems,unfilteredHtml,cssID) VALUES
 (16,1,'tl_article',896,1,'text','a:2:{s:5:"value";s:10:"Textkopf A";s:4:"unit";s:2:"h3";}','<p>Textkoerper</p>',NULL,'','a:2:{i:0;s:0:"";i:1;s:0:"";}'),
 (17,1,'tl_article',1024,1,'list','a:2:{s:5:"value";s:9:"Listkopf ";s:4:"unit";s:2:"h3";}',NULL,'a:1:{i:0;s:7:"Eintrag";}','','a:2:{i:0;s:0:"";i:1;s:0:"";}'),
 (18,1,'tl_article',1152,1,'text','a:2:{s:5:"value";s:10:"Tabellkopf";s:4:"unit";s:2:"h3";}','<table><tr><td>T</td></tr></table>',NULL,'','a:2:{i:0;s:0:"";i:1;s:0:"";}');
INSERT INTO tl_page (id,pid,sorting,tstamp,title,alias,type,language,includeLayout,layout,published,robots,jumpTo,redirect) VALUES (4,1,384,1,'Weiter','weiter','forward','de',0,0,1,'index,follow',2,'permanent');
INSERT INTO tl_page (id,pid,sorting,tstamp,title,alias,type,language,includeLayout,layout,published,robots,hide,url,redirect) VALUES (5,1,512,1,'Extern','extern-weiter','redirect','de',0,0,1,'index,follow',1,'/extern/de/','temporary');
INSERT INTO tl_module (id,pid,tstamp,name,type) VALUES (1,1,1,'Navigation','navigation');
UPDATE tl_layout SET modules='a:2:{i:0;a:3:{s:3:"mod";s:1:"1";s:3:"col";s:4:"main";s:6:"enable";s:1:"1";}i:1;a:3:{s:3:"mod";s:1:"0";s:3:"col";s:4:"main";s:6:"enable";s:1:"1";}}' WHERE id=1;
