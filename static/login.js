(function(){
  const input=document.getElementById('password');
  const toggle=document.getElementById('passwordToggle');
  if(!input||!toggle)return;
  toggle.addEventListener('click',function(){
    const shown=input.type==='text';
    input.type=shown?'password':'text';
    toggle.setAttribute('aria-pressed',String(!shown));
    const label=shown?'显示密码':'隐藏密码';
    toggle.setAttribute('aria-label',label);
    toggle.setAttribute('title',label);
    // 保持焦点并把光标移到末尾，避免切换后光标跳到开头
    const end=input.value.length;
    input.focus();
    try{input.setSelectionRange(end,end)}catch(error){}
  });
})();
