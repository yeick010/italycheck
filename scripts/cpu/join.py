import json, collections, datetime
ev=[json.loads(l) for l in open('events.jsonl') if l.strip()]
by=collections.defaultdict(list)
def shape(e):
    p=e.get('path'); m=e.get('method')
    s=f"{m} {p} {e.get('status')}"
    if p=='/mcp' and m=='POST': s+=f" {e.get('mcp_method')}" + (f"/{e.get('tool')}" if e.get('tool') else "") + (" FAST" if e.get('mcp_fast') else " SDK")
    if e.get('fast_402'): s+=" fast402"
    if e.get('has_payment_header') or e.get('has_mcp_payment'): s+=" PAID"
    return s
for e in ev:
    sec=datetime.datetime.utcfromtimestamp(e['ts']//1000).strftime('%Y-%m-%dT%H:%M:%SZ')
    by[(sec,e.get('v'))].append(e)
probe=lambda e:'italycheck-probe' in (e.get('ua') or '')
allshape=collections.Counter(shape(e) for e in ev if not probe(e))
exact=collections.defaultdict(list); likely=collections.defaultdict(list); amb=[]; nolog=0; tot=0; probes=0
for line in open('rows.txt'):
    sec,v,st,n,cpu=line.split(); n=int(n); cpu=float(cpu)
    if cpu<10: continue
    tot+=1
    es=by.get((sec,v),[])
    if not es: nolog+=1; continue
    if all(probe(e) for e in es): probes+=1; continue
    es=[e for e in es if not probe(e)]
    if len(es)==1 and n==1: exact[shape(es[0])].append(cpu); continue
    slow=[e for e in es if not (e.get('mcp_fast') or e.get('fast_402'))]
    if len(slow)==1: likely[shape(slow[0])].append(cpu)
    else: amb.append((sec,cpu,[shape(e) for e in es]))
print("seconds with max CPU >=10ms:",tot,"no log match:",nolog,"probe-only:",probes)
print("\nEXACT (1 request in that second):")
for k,v in sorted(exact.items(), key=lambda kv:-len(kv[1])): print(f"  {len(v):4d}  max {max(v):6.1f}  med {sorted(v)[len(v)//2]:5.1f}  {k}   (all-time count {allshape[k]})")
print("\nLIKELY (only non-fast request in that second):")
for k,v in sorted(likely.items(), key=lambda kv:-len(kv[1])): print(f"  {len(v):4d}  max {max(v):6.1f}  med {sorted(v)[len(v)//2]:5.1f}  {k}   (all-time count {allshape[k]})")
print("\nAMBIGUOUS:",len(amb))
c=collections.Counter(tuple(sorted(set(s))) for _,_,s in amb)
for k,v in c.most_common(10): print("  ",v,k)
print("\nTop shapes overall (non-probe):")
for k,v in allshape.most_common(30): print(f"  {v:6d} {k}")
