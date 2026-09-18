'use strict';
const {createSign} = require('node:crypto');
const PRODUCTS = new Set(['gallowglass','bowman','huscarl','norman','corsair','horse','andalusian','knight','mamluk','mujahid','crown'].map(id=>'fob_'+id));

// Credentials remain on Render. Never include them in www or GitHub.
function createBilling({env=process.env, fetchImpl=fetch, now=Date.now}={}) {
  let credentials, access, accessUntil=0, refreshing, active=0, requests=0, windowStart=now();
  try { credentials=JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON||'null'); } catch {}
  const packageName=env.GOOGLE_PLAY_PACKAGE_NAME;
  const configured=!!(credentials?.client_email && credentials?.private_key && packageName);
  const fail=(status,message)=>Object.assign(new Error(message),{status});
  async function accessToken() {
    if(access && now()<accessUntil)return access;
    if(refreshing)return refreshing;
    refreshing=(async()=>{
      const seconds=Math.floor(now()/1000);
      const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/androidpublisher',aud:'https://oauth2.googleapis.com/token',iat:seconds,exp:seconds+3600});
      const signature=createSign('RSA-SHA256').update(unsigned).sign(credentials.private_key,'base64url');
      const response=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+signature}),signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw fail(503,'Purchase verification credentials need attention.');
      const data=await response.json();
      if(!data.access_token)throw fail(503,'Purchase verification is unavailable.');
      access=data.access_token;accessUntil=now()+Math.max(0,(Number(data.expires_in)||3600)-60)*1000;
      return access;
    })();
    try{return await refreshing;}finally{refreshing=null;}
  }
  async function verify(input) {
    if(!configured)throw fail(503,'Purchases are not configured on the server yet.');
    const {productId,purchaseToken}=input||{};
    if(!PRODUCTS.has(productId)||typeof purchaseToken!=='string'||purchaseToken.length<1||purchaseToken.length>4096)throw fail(400,'Invalid purchase details.');
    if(now()-windowStart>=60000){windowStart=now();requests=0;}
    if(active>=12||++requests>300)throw fail(429,'Please retry verification shortly.');
    active++;
    try {
      const token=await accessToken();
      const url='https://androidpublisher.googleapis.com/androidpublisher/v3/applications/'+encodeURIComponent(packageName)+'/purchases/products/'+encodeURIComponent(productId)+'/tokens/'+encodeURIComponent(purchaseToken);
      const response=await fetchImpl(url,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});
      if(response.status===401){access=null;throw fail(503,'Purchase verification is temporarily unavailable.');}
      if([400,404,410].includes(response.status))return {productId,owned:false,state:'invalid'};
      if(!response.ok)throw fail(503,'Google Play verification is unavailable. Try Restore later.');
      const purchase=await response.json();
      // Google checks the fixed package, requested product and token together.
      // Pending, cancelled, consumed and refunded purchases never grant ownership.
      const matches=(!purchase.productId||purchase.productId===productId)&&(!purchase.purchaseToken||purchase.purchaseToken===purchaseToken);
      const owned=matches&&purchase.purchaseState===0&&purchase.consumptionState===0;
      return {productId,owned,state:owned?'purchased':purchase.purchaseState===2?'pending':'not-owned'};
    } catch(error) {
      if(error.status)throw error;
      throw fail(503,'Purchase verification is unavailable. Try Restore later.');
    } finally {active--;}
  }
  return {configured,verify};
}
module.exports={createBilling,PRODUCTS};
