'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CHOICES = Object.freeze(['minimize-tray', 'exit-ui']);
const normalize = choice => CHOICES.includes(choice) ? choice : '';

function createClosePolicy(configDir) {
  const file = path.join(configDir, 'ui-preferences.json');
  const read = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
      throw error;
    }
  };
  function get() { return normalize(read().closeChoice); }
  function save(choice) {
    if (choice !== '' && !CHOICES.includes(choice)) throw new Error('Invalid close preference');
    const data = {...read(), formatVersion:1, closeChoice:choice, updatedAt:new Date().toISOString()};
    fs.mkdirSync(configDir,{recursive:true});
    const temporary=file+'.tmp-'+process.pid;
    try {
      fs.writeFileSync(temporary,JSON.stringify(data,null,2)+'\n',{encoding:'utf8',mode:0o600});
      fs.renameSync(temporary,file);
    } finally {
      try { fs.unlinkSync(temporary); } catch(error) { if(error.code!=='ENOENT')throw error; }
    }
    return choice;
  }
  return {get,save,file};
}
module.exports = {createClosePolicy,normalize};
