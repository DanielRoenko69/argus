import { buildOpenApiCatalog } from './openApiCatalog.js';

/**
 * Current, curated OpenAPI contract for the Argus platform.
 *
 * The catalog intentionally documents supported product contracts instead of
 * attempting to expose every private implementation route. Keep endpoint
 * descriptions, authorization requirements and schemas in openApiCatalog.ts.
 */
export const buildOpenApiSpec = buildOpenApiCatalog;

export function buildSwaggerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Argus API Explorer</title>
  <link rel="stylesheet" href="/swagger-ui-dist/swagger-ui.css">
  <style>
    :root{--bg:#070b12;--panel:#0d1421;--panel-2:#111b2b;--line:#243149;--text:#f4f7fb;--muted:#93a4bd;--purple:#9274ff;--cyan:#2dd4bf}
    *{box-sizing:border-box}html{background:var(--bg)}
    body{margin:0;background:radial-gradient(circle at 15% -5%,rgba(124,92,255,.16),transparent 30rem),var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
    .api-shell{position:sticky;top:0;z-index:1000;display:flex;align-items:center;min-height:64px;padding:10px 24px;background:rgba(7,11,18,.94);border-bottom:1px solid var(--line);backdrop-filter:blur(18px)}
    .brand{display:flex;align-items:center;gap:12px;min-width:0;color:var(--text);text-decoration:none}.brand-mark{display:grid;place-items:center;width:38px;height:38px;border:1px solid rgba(146,116,255,.55);border-radius:11px;background:linear-gradient(145deg,rgba(146,116,255,.22),rgba(45,212,191,.08));box-shadow:0 10px 30px rgba(0,0,0,.28)}
    .brand-copy{display:flex;align-items:baseline;gap:9px;min-width:0}.brand-name{font-weight:800;letter-spacing:.15em}.brand-product{color:var(--muted);font-size:13px}.version{margin-left:14px;padding:4px 8px;border:1px solid rgba(45,212,191,.35);border-radius:999px;background:rgba(45,212,191,.08);color:var(--cyan);font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}
    .api-links{margin-left:auto;display:flex;align-items:center;gap:8px}.api-links a{padding:7px 11px;border:1px solid var(--line);border-radius:8px;color:var(--muted);font-size:12px;font-weight:650;text-decoration:none}.api-links a:hover{border-color:#536584;color:var(--text);background:rgba(255,255,255,.03)}
    .api-intro{max-width:1320px;margin:0 auto;padding:28px 28px 8px}.eyebrow{color:var(--purple);font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.api-intro h1{margin:8px 0 7px;font-size:clamp(28px,4vw,42px);line-height:1.08;letter-spacing:-.035em}.api-intro p{max-width:820px;margin:0;color:var(--muted);font-size:14px;line-height:1.65}.api-facts{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.api-fact{padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:rgba(13,20,33,.75);color:#bac7d9;font-size:11px}.api-fact strong{color:var(--text)}
    #swagger-ui-wrap{max-width:1360px;margin:0 auto;padding:4px 28px 72px}.swagger-ui{color:var(--text);font-family:inherit!important}.swagger-ui .topbar{display:none!important}.swagger-ui .info{margin:22px 0 28px}.swagger-ui .info .title{color:var(--text)!important;font-size:25px!important;letter-spacing:-.02em}.swagger-ui .info .title small{background:var(--purple)!important}.swagger-ui .info h1,.swagger-ui .info h2,.swagger-ui .info h3,.swagger-ui .info h4,.swagger-ui .info h5{color:#dce5f2!important}.swagger-ui .info p,.swagger-ui .info li,.swagger-ui .info table{color:var(--muted)!important}.swagger-ui .info a,.swagger-ui a.nostyle{color:#b7a5ff!important}.swagger-ui .info .base-url{color:var(--muted)!important}
    .swagger-ui .scheme-container{margin:0 0 24px;padding:18px 20px;background:var(--panel)!important;border:1px solid var(--line);border-radius:12px;box-shadow:none!important}.swagger-ui .auth-wrapper .authorize{border-color:var(--purple)!important;color:#c5b8ff!important}.swagger-ui .auth-wrapper .authorize svg{fill:var(--purple)!important}.swagger-ui .filter-container{margin:0 0 22px;padding:0!important}.swagger-ui .filter-container .operation-filter-input{max-width:none;width:100%;padding:12px 14px;border:1px solid var(--line)!important;border-radius:10px;background:var(--panel)!important;color:var(--text)!important;font-size:14px}
    .swagger-ui .opblock-tag{margin:28px 0 8px;padding:12px 2px 10px;border-bottom:1px solid var(--line)!important;color:var(--text)!important;font-size:19px!important}.swagger-ui .opblock-tag small{color:var(--muted)!important;font-size:12px!important;font-weight:450!important}.swagger-ui .opblock-tag svg{fill:var(--muted)!important}.swagger-ui .opblock{margin:7px 0!important;border:1px solid var(--line)!important;border-radius:9px!important;background:var(--panel)!important;box-shadow:none!important}.swagger-ui .opblock .opblock-summary{border-color:var(--line)!important}.swagger-ui .opblock .opblock-summary-method{min-width:72px;border-radius:6px!important;text-shadow:none!important}.swagger-ui .opblock .opblock-summary-path{color:var(--text)!important;font:650 13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace!important}.swagger-ui .opblock .opblock-summary-description{color:var(--muted)!important;font-size:13px!important}.swagger-ui .opblock .opblock-section-header{background:var(--panel-2)!important;box-shadow:none!important}.swagger-ui .opblock .opblock-section-header h4,.swagger-ui .opblock-description-wrapper p,.swagger-ui .response-col_status,.swagger-ui .response-col_description,.swagger-ui .parameter__name,.swagger-ui label{color:#ccd6e5!important}.swagger-ui .parameter__type,.swagger-ui .prop-type{color:#b7a5ff!important}
    .swagger-ui input[type=text],.swagger-ui input[type=password],.swagger-ui input[type=email],.swagger-ui textarea,.swagger-ui select{border:1px solid var(--line)!important;border-radius:7px!important;background:#080d16!important;color:var(--text)!important}.swagger-ui .btn{border-radius:7px!important}.swagger-ui .btn.execute{border-color:var(--purple)!important;background:var(--purple)!important;color:white!important}.swagger-ui .highlight-code,.swagger-ui .microlight,.swagger-ui pre{background:#050810!important;color:#cbd5e1!important}.swagger-ui table thead tr td,.swagger-ui table thead tr th{border-color:var(--line)!important;color:var(--muted)!important}.swagger-ui section.models{margin:34px 0 0;border:1px solid var(--line)!important;border-radius:10px!important;background:var(--panel)!important}.swagger-ui section.models h4,.swagger-ui .model-title,.swagger-ui .model{color:var(--text)!important}.swagger-ui .model-box{background:var(--panel-2)!important}.swagger-ui .model-toggle:after{background:#a9b6ca!important}.swagger-ui .servers>label{color:var(--muted)!important}.swagger-ui .loading-container .loading:after{color:var(--muted)!important}
    @media(max-width:720px){.api-shell{padding:9px 14px}.brand-product,.version,.api-links a:not(:last-child){display:none}.api-intro,#swagger-ui-wrap{padding-left:14px;padding-right:14px}.swagger-ui .opblock .opblock-summary-description{display:none}.swagger-ui .opblock .opblock-summary-path{word-break:break-word}}
  </style>
</head>
<body>
  <header class="api-shell">
    <a class="brand" href="/home" aria-label="Argus home"><span class="brand-mark" aria-hidden="true"><svg width="23" height="23" viewBox="0 0 24 24" fill="none"><path d="M12 2.8 20.4 7v10L12 21.2 3.6 17V7L12 2.8Z" stroke="#b9a9ff" stroke-width="1.7"/><path d="m8 15.8 4-8 4 8M9.4 13h5.2" stroke="#f7f8fc" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="brand-copy"><span class="brand-name">ARGUS</span><span class="brand-product">API Explorer</span></span></a>
    <span class="version">OpenAPI 3.0</span>
    <nav class="api-links" aria-label="API resources"><a href="/home">Console</a><a href="/settings/identity">Identity &amp; access</a><a href="/openapi.json" download="argus-openapi.json">Download JSON</a></nav>
  </header>
  <section class="api-intro"><div class="eyebrow">Developer platform · Governed interfaces</div><h1>Build against Argus with confidence.</h1><p>Explore the supported contracts for agents, workflows, MCP Fabric, knowledge and Graphify, AIOps, audit evidence, AI compliance and managed Hermes runtimes. Authentication and role requirements are shown per operation.</p><div class="api-facts"><span class="api-fact"><strong>Session, API key or bearer</strong> authentication</span><span class="api-fact"><strong>Try it out</strong> against this deployment</span><span class="api-fact"><strong>Machine-readable</strong> OpenAPI download</span></div></section>
  <main id="swagger-ui-wrap"><div id="swagger-ui"></div></main>
  <script src="/swagger-ui-dist/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',deepLinking:true,displayRequestDuration:true,persistAuthorization:true,tryItOutEnabled:true,filter:true,docExpansion:'list',defaultModelsExpandDepth:1,defaultModelExpandDepth:2,displayOperationId:true,syntaxHighlight:{activate:true,theme:'agate'},presets:[SwaggerUIBundle.presets.apis,SwaggerUIBundle.SwaggerUIStandalonePreset],layout:'BaseLayout',requestInterceptor:function(request){var key=localStorage.getItem('argus_api_key');if(key&&!request.headers['X-API-Key']&&!request.headers.Authorization)request.headers['X-API-Key']=key;return request;}});
  </script>
</body>
</html>`;
}
