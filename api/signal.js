'use strict';
// Compatibility error: old WebRTC offers/answers are no longer used.
module.exports=(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS')return res.status(204).end();
  return res.status(410).json({error:'Client upgrade required: use the temporary message relay'});
};
