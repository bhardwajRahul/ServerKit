import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// Exercise the real login/SSO pages and layout hooks under React StrictMode.
// Only authentication, translation, and HTTP boundaries are replaced by
// controlled fixtures; no backend server or account credentials are needed.
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = `
import React, {useState, useRef, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter, Routes, Route} from 'react-router-dom';
import Login from '/src/pages/Login.jsx';
import SSOCallback from '/src/pages/SSOCallback.jsx';
import {useOverflowItems} from '/src/hooks/useOverflowItems.js';
import useFocusTrap from '/src/hooks/ai/useFocusTrap.js';
window.calls=[]; window.users=[]; window.reads=0;
window.onUser=user=>window.users.push(user);
window.testApi={
 getDemoInfo: async()=>({enabled:false}), setTokens:()=>{},
 verify2FA:(token,code)=>{window.calls.push({type:'verify',token,code});return new Promise((resolve,reject)=>{window.finish=resolve;window.fail=reject})},
 completeSSOAuth:(provider,code,state)=>{window.calls.push({type:'sso',provider,code,state});return new Promise(resolve=>{window.finish=resolve})}
};
const mode=new URL(location.href).searchParams.get('mode');
function Overflow(){
 const [count,setCount]=useState(4);const [extra,setExtra]=useState(0);
 const {containerRef,itemRefs,hiddenIndices}=useOverflowItems({count,gap:0,moreWidth:20,deps:[extra]});
 window.changeExtra=()=>setExtra(n=>n+1);window.changeCount=setCount;
 return <><div ref={containerRef} style={{width:180,display:'flex'}}>{Array.from({length:count},(_,i)=><div key={i} ref={el=>{itemRefs.current[i]=el;if(el)Object.defineProperty(el,'offsetWidth',{configurable:true,get(){window.reads++;return 80}})}} style={{width:80,flexShrink:0}}>Item</div>)}</div><output>{JSON.stringify(hiddenIndices)}</output></>
}
function Focus(){
 const [active,setActive]=useState(true);const box=useRef(null);const first=useRef(null);const second=useRef(null);const restore=useRef(null);
 useEffect(()=>{restore.current=first.current;window.deactivate=()=>{restore.current=second.current;setActive(false)}},[]);
 useFocusTrap(box,{active,restoreFocusRef:restore});
 return <><button id="first" ref={first}>first</button><button id="second" ref={second}>second</button><div ref={box}><button>inside</button></div></>
}
function App(){
 const [,setTick]=useState(0);window.bump=()=>setTick(n=>n+1);
 if(mode==='overflow')return <Overflow/>;if(mode==='focus')return <Focus/>;
 const entry=mode==='sso'?'/login/callback/test?code=code1&state=state1':{pathname:'/login',state:{requires2FA:true,tempToken:'challenge1'}};
 return <MemoryRouter initialEntries={[entry]}><Routes><Route path="/login" element={<Login/>}/><Route path="/login/callback/:provider" element={<SSOCallback/>}/><Route path="*" element={<div id="done">done</div>}/></Routes></MemoryRouter>
}
createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
`;
const server = await createServer({
 root, configFile:false, logLevel:'error', resolve:{alias:{'@':path.join(root,'src')}},
 cacheDir: path.join(root, 'node_modules/.vite-hooks-regression'),
 optimizeDeps: { entries: [] },
 server:{host:'127.0.0.1',port:0},
 plugins:[{
  name:'hook-regression-fixtures',enforce:'pre',
  resolveId(id){if(id==='react-i18next')return '\0test-i18n';if(id.endsWith('/hook-fixture.jsx'))return path.join(root,'hook-fixture.jsx')},
  load(id){
   const normalized=id.replaceAll('\\','/');
   if(id==='\0test-i18n')return `const t=(key,fallback)=>typeof fallback==='string'?fallback:key;export const useTranslation=()=>({t});export const Trans=({children})=>children;`;
   if(normalized.endsWith('/src/contexts/useAuth.js'))return `export const useAuth=()=>({setUser:window.onUser,ssoProviders:[],passwordLoginEnabled:true,publicTitle:'Control panel'});`;
   if(normalized.endsWith('/src/pages/auth/AuthLayout.jsx'))return `export default function AuthLayout({children}){return children}`;
   if(normalized.endsWith('/src/services/api.js')||normalized.endsWith('/src/services/api/index.js'))return `export default new Proxy({}, {get:(_,key)=>(...args)=>window.testApi[key](...args)});`;
   if(normalized.endsWith('/hook-fixture.jsx'))return fixture;
  },
  configureServer(server){server.middlewares.use('/hook-check',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/hook-check','<div id="root"></div><script type="module" src="/hook-fixture.jsx"></script>'))})}
 },react()],
});
const executablePath = [
 process.env.CHROME_PATH,
 chromium.executablePath(),
 'C:/Program Files/Google/Chrome/Application/chrome.exe',
 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => candidate && existsSync(candidate));

let browser;
try {
 await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
 browser=await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });const page=await browser.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin+'/hook-check?mode=login');await page.locator('.totp-input').first().waitFor();
 async function digits(){for(let i=0;i<6;i++)await page.locator('.totp-input').nth(i).fill(String(i+1))}
 await digits();await page.waitForFunction(()=>window.calls.length===1);
 await page.evaluate(()=>{window.bump();document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});
 await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.calls.length),1);
 await page.evaluate(()=>window.fail(new Error('Invalid verification code')));
 await page.waitForFunction(()=>[...document.querySelectorAll('.totp-input')].every(el=>el.value===''));
 await digits();await page.waitForFunction(()=>window.calls.length===2);
 await page.evaluate(()=>window.finish({access_token:'a',refresh_token:'r',user:{id:7}}));
 await page.locator('#done').waitFor();assert.equal(await page.evaluate(()=>window.calls.length),2);
 console.log('PASS TOTP single in-flight request, rerender guard, retry after rejection and successful navigation');
 await page.goto(origin+'/hook-check?mode=sso');await page.waitForFunction(()=>window.calls.length===1);
 await page.evaluate(()=>window.bump());await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>window.calls.length),1);
 await page.evaluate(()=>window.finish({requires_2fa:true,temp_token:'sso-challenge'}));
 await page.locator('.totp-input').first().waitFor();assert.equal(await page.evaluate(()=>window.calls.length),1);
 console.log('PASS SSO exchanges once under StrictMode and rerender, then forwards MFA challenge');
 await page.goto(origin+'/hook-check?mode=overflow');await page.locator('output').waitFor();await page.waitForTimeout(200);
 assert.equal(await page.locator('output').textContent(),'[2,3]');
 const reads=await page.evaluate(()=>window.reads);await page.evaluate(()=>window.bump());await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>window.reads),reads);
 await page.evaluate(()=>window.changeExtra());await page.waitForFunction(n=>window.reads>n,reads);
 await page.evaluate(()=>window.changeCount(1));await page.waitForFunction(()=>document.querySelector('output').textContent==='[]');
 console.log('PASS overflow measurement skips identical dependency values and responds to changed values/count');
 await page.goto(origin+'/hook-check?mode=focus');await page.locator('#first').waitFor();await page.waitForTimeout(100);
 await page.evaluate(()=>window.deactivate());await page.waitForFunction(()=>document.activeElement.id==='first');
 console.log('PASS focus restores activation target after ref changes');
 assert.deepEqual(errors,[]);
} finally {await browser?.close();await server.close()}
