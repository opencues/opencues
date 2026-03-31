// Please see the note about writing patches in ./index

import { LocationResult, showDiff, getRequireFuncName } from './index';

/**
 * Find the input state handler function (NV1 in v2.1.x, f31 in v2.0.x).
 *
 * Pattern: function XXX({value:X,onChange:X,...externalOffset:X,onOffsetChange:X...})
 *
 * This function handles all input state management including cursor position.
 */
const findInputStateHandlerLocation = (oldFile: string): LocationResult | null => {
  // Find the input state handler function definition
  // v2.1.x has an if() statement before the let declarations
  // v2.0.x has let declarations immediately
  // Pattern: function XXX({value:A,...externalOffset:j,onOffsetChange:M...}){...let T=j,k=M,R=InputZone.fromText(
  const funcPattern =
    /function ([$\w]+)\(\{value:([$\w]+),onChange:([$\w]+),[^}]+externalOffset:([$\w]+),onOffsetChange:([$\w]+)[^}]+\}\)\{[^}]*let ([$\w]+)=\4,([$\w]+)=\5,([$\w]+)=([$\w]+)\.fromText\(/;

  const match = oldFile.match(funcPattern);

  if (!match || match.index === undefined) {
    console.error('patch: cursorStateExport: failed to find input state handler function pattern');
    return null;
  }

  // Find the return statement in the function
  // Pattern: return{onInput:X,renderedValue:
  const funcStart = match.index;
  const searchSection = oldFile.slice(funcStart, funcStart + 10000);

  const returnPattern = /return\{onInput:([$\w]+),renderedValue:/;
  const returnMatch = searchSection.match(returnPattern);

  if (!returnMatch || returnMatch.index === undefined) {
    console.error('patch: cursorStateExport: failed to find return statement in input handler');
    return null;
  }

  return {
    startIndex: funcStart + returnMatch.index,
    endIndex: funcStart + returnMatch.index,
    identifiers: [
      match[1],   // function name (NV1 or f31)
      match[2],   // value param name (A)
      match[3],   // onChange param name (K)
      match[4],   // externalOffset param name (j)
      match[5],   // onOffsetChange param name (M)
      match[6],   // T variable (assigned from externalOffset)
      match[7],   // k variable (assigned from onOffsetChange)
      match[8],   // R variable (InputZone instance)
      match[9],   // InputZone class name (i5)
      returnMatch[1], // onInput function name (BA)
    ],
  };
};

/**
 * Write cursor state export patch.
 *
 * This injects code into the input handler function to write cursor state to a file
 * whenever the input value or cursor position changes.
 */
export const writeCursorStateExport = (
  oldFile: string,
  exportPath: string = '/tmp/claude-cursor-state.json'
): string | null => {
  const location = findInputStateHandlerLocation(oldFile);
  if (!location) {
    return null;
  }

  // Identifiers from the pattern match:
  // [0] function name, [1] value param, [2] onChange, [3] externalOffset param,
  // [4] onOffsetChange param, [5] T var, [6] k var, [7] R var (InputZone),
  // [8] InputZone class, [9] onInput name
  const valueParam = location.identifiers![1];
  const offsetVar = location.identifiers![5]; // T - the actual offset variable used

  const requireFuncName = getRequireFuncName(oldFile);

  // Create the cursor state export code
  // This code will be injected just before the return statement in the input handler
  // Uses debounced async writes to avoid blocking the UI on every keystroke
  const exportCode = `
(function(){
  try{
    var _text=${valueParam};
    var _offset=${offsetVar}??0;
    var _words=_text.split(/\\s+/);
    var _pos=0;
    var _currentWord="";
    for(var _i=0;_i<_words.length;_i++){
      var _wEnd=_pos+_words[_i].length;
      if(_offset>=_pos&&_offset<=_wEnd){_currentWord=_words[_i];break}
      _pos=_wEnd+1;
    }
    var _data={
      text:_text,
      cursorPosition:_offset,
      currentWord:_currentWord,
      atEnd:_offset>=_text.length,
      textLength:_text.length,
      timestamp:Date.now()
    };
    if(globalThis._cwt)clearTimeout(globalThis._cwt);
    globalThis._cwt=setTimeout(function(){
      ${requireFuncName}("fs").promises.writeFile("${exportPath}",JSON.stringify(_data)).catch(function(){});
    },100);
  }catch(_e){}
})();
`;

  const newFile =
    oldFile.slice(0, location.startIndex) +
    exportCode +
    oldFile.slice(location.endIndex);

  showDiff(
    oldFile,
    newFile,
    exportCode,
    location.startIndex,
    location.endIndex
  );

  return newFile;
};
