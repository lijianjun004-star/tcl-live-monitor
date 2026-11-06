// Diagnostic stop cues; ordinary login links are not proof of an access gate.
export function accessCue({title='',text='',finalHost='',finalPath=''}={}) {
 if(/(^|\.)(login\.taobao\.com|login\.m\.taobao\.com|passport\.jd\.com)$/.test(finalHost)) return {kind:'LOGIN_REDIRECT',matched:finalHost};
 if(/captcha|verify|challenge/i.test(finalPath)) return {kind:'CHALLENGE_PATH',matched:finalPath.slice(0,100)};
 const challenge=/(验证码中间页|安全验证|滑块验证|captcha)/i.exec(title);
 if(challenge)return {kind:'CHALLENGE_TITLE',matched:challenge[0]};
 if(/^\s*(登录|用户登录|账号登录|Login|Sign in)\s*$/i.test(title))return {kind:'LOGIN_TITLE',matched:title};
 const explicit=/(请先登录后观看|登录后观看完整|扫码登录后观看|请完成安全验证|请完成滑块验证)/.exec(text);
 return explicit?{kind:'EXPLICIT_ACCESS_CUE',matched:explicit[0]}:null;
}
