'use strict';
// Supply MONO_RELEASE_VERSION / URL / SHA256 / NOTES in server environment on release.
// The installer MUST be a signed Windows build, uploaded separately to HTTPS storage.
module.exports=async(req,res)=>{
res.setHeader('Cache-Control','public, max-age=60, s-maxage=60');
res.setHeader('Access-Control-Allow-Origin','*');
if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
const version=process.env.MONO_RELEASE_VERSION,url=process.env.MONO_RELEASE_URL,sha256=process.env.MONO_RELEASE_SHA256;
if(!version||!url||!sha256)return res.status(200).json({available:false});
if(!/^\d+\.\d+\.\d+$/.test(version)||!/^https:\/\//.test(url)||!/^[a-f0-9]{64}$/i.test(sha256))return res.status(500).json({available:false,error:'Bad release configuration'});
return res.status(200).json({available:true,version,url,sha256,notes:String(process.env.MONO_RELEASE_NOTES||'').slice(0,1500)});
};
