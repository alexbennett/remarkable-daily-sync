import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {zipSync,strToU8,strFromU8} from 'fflate';
import {prepareCPagesUpdate} from '../src/cpages';
const doc = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ids = ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
const ink = `${doc}/${ids[0]}.rm`;
async function pdf(count:number) { const p=await PDFDocument.create(); p.setCreationDate(new Date(0));p.setModificationDate(new Date(0)); for(let i=0;i<count;i++) p.addPage([702,936]);return p.save(); }
function metadata() {return {fileType:'pdf',formatVersion:2,pageCount:2,extraMetadata:{preserve:'yes'}, cPages:{
 original:{timestamp:'1:1',value:2},lastOpened:{timestamp:'1:9',value:ids[0]},
 uuids:[{first:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',second:1}],
 pages:ids.map((id,index)=>({id,idx:{timestamp:'1:2',value:index?'bb':'ba'},redir:{timestamp:'1:2',value:index},template:{timestamp:'1:2',value:'Blank'},modifed:'123',custom:{preserve:true}}))}};}
async function archive(content:any=metadata()) { return zipSync({[`${doc}.pdf`]:await pdf(2),[`${doc}.content`]:strToU8(JSON.stringify(content)),[ink]:new Uint8Array([1,2,3])}); }

test('experimental same-size refresh redirects only selected pages and requires processed ink',async()=>{
 const input=await archive(),newPdf=await pdf(1),original=metadata();
 await assert.rejects(prepareCPagesUpdate(input,newPdf,{pageIds:[ids[0]],processedInkFiles:[]}),/not explicitly marked processed/);
 const result=await prepareCPagesUpdate(input,newPdf,{pageIds:[ids[0]],processedInkFiles:[ink]});
 const content=JSON.parse(strFromU8(result.content));
 assert.equal(content.pageCount,2);assert.equal(content.cPages.original.value,3);
 assert.equal(content.cPages.pages[0].redir.value,2);assert.equal(content.cPages.pages[0].redir.timestamp,'2:10');
 assert.deepEqual(content.cPages.pages[1],original.cPages.pages[1]);
 assert.deepEqual(content.cPages.lastOpened,original.cPages.lastOpened);assert.deepEqual(content.extraMetadata,original.extraMetadata);
 assert.deepEqual(content.cPages.pages[0].idx,original.cPages.pages[0].idx);
 assert.deepEqual(result.deleteFiles,[ink]);assert.deepEqual(result.pages,[{pageId:ids[0],pdfPage:3}]);
 const again=await prepareCPagesUpdate(input,newPdf,{pageIds:[ids[0]],processedInkFiles:[ink]});
 assert.deepEqual(result,again);assert.equal((await PDFDocument.load(result.pdf)).getPageCount(),3);
 const before=await PDFDocument.load((await import('fflate')).unzipSync(input)[`${doc}.pdf`]);
 const after=await PDFDocument.load(result.pdf);
 assert.equal(before.getPage(0).node.toString(),after.getPage(0).node.toString());
});

test('last entry grows, shrink tombstones surplus records, append initializes new page identities',async()=>{
 const input=await archive();
 const growing=await prepareCPagesUpdate(input,await pdf(2),{pageIds:[ids[1]],processedInkFiles:[]});
 const content=JSON.parse(strFromU8(growing.content));
 assert.equal(content.pageCount,3);assert.equal(content.cPages.pages[2].idx.value,'bc');assert.equal(growing.pages[0].pageId,ids[1]);assert.equal(growing.pages[1].pdfPage,4);
 const shrunk=await prepareCPagesUpdate(input,await pdf(1),{pageIds:ids,processedInkFiles:[ink]});
 const shrunkContent=JSON.parse(strFromU8(shrunk.content));assert.equal(shrunkContent.pageCount,1);assert.equal(shrunkContent.cPages.pages.length,2);assert.equal(shrunkContent.cPages.pages[1].deleted.value,1);
 assert.deepEqual(shrunkContent.cPages.pages[1].redir,metadata().cPages.pages[1].redir);
 const appended=await prepareCPagesUpdate(input,await pdf(1),{pageIds:[],processedInkFiles:[]});
 assert.equal(JSON.parse(strFromU8(appended.content)).pageCount,3);assert.notEqual(appended.pages[0].pageId,ids[0]);
});

test('writer rejects unknown shapes and unsafe ink deletion',async()=>{
 const input=await archive(),one=await pdf(1),two=await pdf(2);
 const middle=await prepareCPagesUpdate(input,two,{pageIds:[ids[0]],processedInkFiles:[ink]});
 assert.equal(JSON.parse(strFromU8(middle.content)).cPages.pages[2].idx.value,'bab');
 await assert.rejects(prepareCPagesUpdate(input,one,{pageIds:[ids[1]],processedInkFiles:[ink]}),/not an existing selected/);
 await assert.rejects(prepareCPagesUpdate(input,one,{pageIds:[...ids].reverse(),processedInkFiles:[ink]}),/contiguous/);
 const variants=[(c:any)=>c.cPages.pages[0].idx.value='ba1',(c:any)=>c.cPages.pages[0].redir.value=-2,(c:any)=>c.cPages.pages[0].idx.timestamp='9:3',(c:any)=>c.pageCount=3,(c:any)=>c.cPages.original.value=3,(c:any)=>c.cPages.uuids.push(c.cPages.uuids[0])];
 for(const mutate of variants){const c=metadata();mutate(c);await assert.rejects(prepareCPagesUpdate(await archive(c),one,{pageIds:[],processedInkFiles:[]}),/refused/);}
});

test('a subsequent update reuses its document actor and advances the observed clock',async()=>{
 const initial=await prepareCPagesUpdate(await archive(),await pdf(1),{pageIds:[ids[0]],processedInkFiles:[ink]});
 const nextArchive=zipSync({[`${doc}.pdf`]:initial.pdf,[`${doc}.content`]:initial.content});
 const next=await prepareCPagesUpdate(nextArchive,await pdf(1),{pageIds:[ids[0]],processedInkFiles:[]});
 const content=JSON.parse(strFromU8(next.content));assert.equal(content.cPages.uuids.length,2);assert.equal(content.cPages.pages[0].redir.timestamp,'2:11');
});

test('native inserted blank bab and its ink survive middle growth between ba and bab',async()=>{
 const blankId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 const base:any=metadata();
 const blank={id:blankId,idx:{timestamp:'1:3',value:'bab'},modifed:'1793579781960'};
 base.cPages.pages.splice(1,0,blank);base.pageCount=3;
 const blankInk=`${doc}/${blankId}.rm`;
 const blankBytes=new Uint8Array([8,9,10]);
 const input=zipSync({[`${doc}.pdf`]:await pdf(2),[`${doc}.content`]:strToU8(JSON.stringify(base)),[ink]:new Uint8Array([1,2,3]),[blankInk]:blankBytes});
 const before=input.slice();
 const result=await prepareCPagesUpdate(input,await pdf(3),{pageIds:[ids[0]],processedInkFiles:[ink]});
 const content=JSON.parse(strFromU8(result.content));
 assert.equal(content.pageCount,5);
 assert.deepEqual(content.cPages.pages.slice(1,3),base.cPages.pages.slice(1,3));
 assert.equal(content.cPages.pages[3].idx.value,'baab');assert.equal(content.cPages.pages[4].idx.value,'baabb');
 assert.deepEqual(result.deleteFiles,[ink]);assert.deepEqual(input,before);
 assert.deepEqual((await import('fflate')).unzipSync(input)[blankInk],blankBytes);
 await assert.rejects(prepareCPagesUpdate(input,await pdf(1),{pageIds:[blankId],processedInkFiles:[blankInk]}),/native blank/);
 base.cPages.pages[1].idx.value='baa';
 await assert.rejects(prepareCPagesUpdate(await archive(base),await pdf(2),{pageIds:[ids[0]],processedInkFiles:[ink]}),/ordering interval/);
});

test('initialized legacy refresh grows in the middle, shrinks, and preserves native blank IDs',async()=>{
 const blank='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 const content={fileType:'pdf',formatVersion:1,pages:[ids[0],blank,ids[1]],redirectionPageMap:[0,-1,1],pageCount:3,originalPageCount:2,lastOpenedPage:2,extraMetadata:{keep:'yes'}};
 const blankFile=`${doc}/${blank}.rm`;
 const input=zipSync({[`${doc}.pdf`]:await pdf(2),[`${doc}.content`]:strToU8(JSON.stringify(content)),[ink]:new Uint8Array([1]),[blankFile]:new Uint8Array([2])});
 const result=await prepareCPagesUpdate(input,await pdf(2),{pageIds:[ids[0]],processedInkFiles:[ink]});
 const updated=JSON.parse(strFromU8(result.content));
 assert.equal(updated.pages[0],ids[0]);assert.deepEqual(updated.pages.slice(2),[blank,ids[1]]);
 assert.deepEqual(updated.redirectionPageMap,[2,3,-1,1]);assert.equal(updated.originalPageCount,4);assert.equal(updated.pageCount,4);
 assert.equal(updated.lastOpenedPage,2);assert.deepEqual(updated.extraMetadata,content.extraMetadata);assert.deepEqual(result.deleteFiles,[ink]);
 const nextArchive=zipSync({[`${doc}.pdf`]:result.pdf,[`${doc}.content`]:result.content,[blankFile]:new Uint8Array([2])});
 const shrunk=await prepareCPagesUpdate(nextArchive,await pdf(1),{pageIds:result.pages.map(p=>p.pageId),processedInkFiles:[]});
 const next=JSON.parse(strFromU8(shrunk.content));
 assert.deepEqual(next.pages,[ids[0],blank,ids[1]]);assert.deepEqual(next.redirectionPageMap,[4,-1,1]);assert.equal(next.originalPageCount,5);
 await assert.rejects(prepareCPagesUpdate(input,await pdf(1),{pageIds:[blank],processedInkFiles:[blankFile]}),/native blank/);
 const pristine={...content,pages:null,redirectionPageMap:null,pageCount:0};
 await assert.rejects(prepareCPagesUpdate(await archive(pristine),await pdf(1),{pageIds:[],processedInkFiles:[]}),/initialized legacy/);
 const noCount={...content,originalPageCount:undefined};
 await assert.rejects(prepareCPagesUpdate(await archive(noCount),await pdf(1),{pageIds:[],processedInkFiles:[]}),/count or redirect/);
});

test('initialized legacy maps allow absent formatVersion without inventing one',async()=>{
 const content={fileType:'pdf',pages:ids,redirectionPageMap:[0,1],pageCount:2,originalPageCount:2};
 const input=await archive(content);
 const result=await prepareCPagesUpdate(input,await pdf(1),{pageIds:[ids[1]],processedInkFiles:[]});
 const updated=JSON.parse(strFromU8(result.content));
 assert.equal(Object.hasOwn(updated,'formatVersion'),false);
 assert.deepEqual(updated.redirectionPageMap,[0,2]);
 for(const formatVersion of [null,0,3]) await assert.rejects(prepareCPagesUpdate(await archive({...content,formatVersion}),await pdf(1),{pageIds:[],processedInkFiles:[]}),/refused/);
 await assert.rejects(prepareCPagesUpdate(await archive({...content,pages:null,redirectionPageMap:null,pageCount:0}),await pdf(1),{pageIds:[],processedInkFiles:[]}),/initialized legacy/);
});
