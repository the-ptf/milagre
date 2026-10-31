const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const args = process.argv.slice(2);
const output = args[args.indexOf("--out") + 1];
if (!args.includes("--out") || !output) throw Error("Usage: node scripts/html-eval/serve.cjs --out DIRECTORY [--port 5191]");
const out = path.resolve(output);
const port = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : 5191);
const requireRoot = require("node:module").createRequire(root + "/package.json");
const fs = require("node:fs");
(async () => {
  const { createServer } = await import(requireRoot.resolve("vite"));
  const module = `import React from 'react';import {createRoot} from 'react-dom/client';import {ArtifactsProvider,ArtifactCards} from '/src/components/agents/ArtifactCard';import '/src/styles.css';import {ScrollArea} from '/src/components/primitives/ScrollArea';import {THEME_EVENT} from '/src/lib/theme-sheet';
const items=await fetch('/__eval-data').then(r=>r.json());const params=new URLSearchParams(location.search);const i=params.has('session')?items.findIndex(v=>v.sessionId===params.get('session')):Number(params.get('case')||0);const item=items[i];if(!item)throw Error('No successful generation at this index');
if(new URLSearchParams(location.search).get('theme')==='dark')document.documentElement.classList.add('dark');document.body.className='bg-page';
const page={id:'generated-'+i,title:item.title,version:1,format:'html',inline:true,height:item.height||400};const steps=[{id:'tool-'+i,kind:'artifact',status:'done',tool:'html_render',artifact:page}];
window.milagre={readDesignsEnabled:async()=>({enabled:false}),onDesignsEnabledChanged:()=>()=>{},artifacts:{list:async()=>[],comments:async()=>[],get:async()=>({...page,html:item.html})}};
createRoot(document.getElementById('root')).render(<ScrollArea style={{height:'100%'}}><main style={{maxWidth:768,margin:'0 auto',padding:'24px 16px'}}><header style={{marginBottom:24}}><p>Eval fixture · HTML original · sessão {item.sessionId}</p><label>Caso <select style={{maxWidth:"100%"}} value={i} onChange={e=>location.search='?case='+e.target.value+(document.documentElement.classList.contains('dark')?'&theme=dark':'')}>{items.map((v,n)=><option value={n} key={n}>{v.sessionId}: {v.title}</option>)}</select></label><button style={{marginLeft:12}} onClick={()=>{document.documentElement.classList.toggle('dark');window.dispatchEvent(new Event(THEME_EVENT));}}>Alternar tema</button></header><div className="text-[length:var(--chat-size)] leading-[1.55] text-ink"><p style={{marginBottom:20}}>{item.prompt}</p><ArtifactsProvider chatId="/eval#1" steps={steps} userMessages={[]}><ArtifactCards steps={steps}/></ArtifactsProvider><p data-eval-next-message style={{marginTop:16}}>Fim da resposta. A altura acima deve acompanhar as interações.</p></div></main></ScrollArea>);`;
  const server = await createServer({
    configFile: path.join(root, "vite.config.ts"),
    server: { host: "0.0.0.0", port, strictPort: true, hmr: false, watch: null },
    plugins: [
      {
        name: "eval-fixture",
        resolveId: (id) => (id === "/__eval.tsx" ? id : null),
        load: (id) => (id === "/__eval.tsx" ? module : null),
        configureServer(viteServer) {
          viteServer.middlewares.use((req, res, next) => {
            try {
              // Serve only review evidence, never private MCP configs or executable generated HTML.
              const route = new URL(req.url, "http://eval.invalid").pathname;
              if (/^\/(report\.(html|md)|inspection\/[a-z0-9-]+\/(final-[0-9]+-(light|dark)\.png|final-source\.txt))$/.test(route)) {
                const file = path.join(out, route.slice(1));
                res.setHeader(
                  "Content-Type",
                  route.endsWith(".png") ? "image/png" : route.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
                );
                res.end(fs.readFileSync(file));
                return;
              }
              if (req.url === "/__eval-data") {
                const index = JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8"));
                const items = index.sessions
                  .filter((s) => s.final)
                  .map((s) => ({ sessionId: s.sessionId, title: s.final.title, prompt: s.prompt, htmlFile: s.final.htmlFile, height: s.final.height }));
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(items.map((x) => Object.assign({}, x, { html: fs.readFileSync(x.htmlFile, "utf8") }))));
                return;
              }
              if (req.url?.startsWith("/?") || req.url === "/") {
                res.setHeader("Content-Type", "text/html");
                void viteServer
                  .transformIndexHtml(
                    "/",
                    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__eval.tsx"></script></body></html>',
                  )
                  .then(
                    (html) => res.end(html),
                    (error) => {
                      res.statusCode = 500;
                      res.end(error.message);
                    },
                  );
                return;
              }
              next();
            } catch (e) {
              res.statusCode = 500;
              res.end(e.message);
            }
          });
        },
      },
    ],
  });
  await server.listen();
  console.log("HTML eval fixture listening on 0.0.0.0:" + port);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
})();
