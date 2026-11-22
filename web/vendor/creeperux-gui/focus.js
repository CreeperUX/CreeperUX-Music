export function focusTarget(candidates,{exclude=null,predicate=()=>true}={}){
 for(const node of candidates){
  if(!node?.isConnected||typeof node.focus!=='function'||exclude&&(node===exclude||exclude.contains(node))||!predicate(node))continue;
  if(node.closest('[hidden],[inert],[aria-hidden="true"]')||node.matches(':disabled,[aria-disabled="true"]')||!node.getClientRects().length)continue;
  const rect=node.getBoundingClientRect();if(rect.width<=0||rect.height<=0)continue;
  const css=node.ownerDocument.defaultView.getComputedStyle(node);if(css.visibility==='hidden'||css.visibility==='collapse')continue;
  const temporary=!node.matches('button,input,select,textarea,a[href],area[href],[tabindex],[contenteditable="true"]');if(temporary)node.tabIndex=-1;
  node.focus({preventScroll:true});let active=node.ownerDocument.activeElement;while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;
  if(active===node)return node;if(temporary)node.removeAttribute('tabindex');
 }
 return null;
}
export function ancestorFocusTargets(node){const result=[];for(let current=node.parentElement;current;current=current.parentElement)result.push(current);return result;}
