/** Auxiliary measurements must never reject the run-unit lifecycle promise. */
export async function auxiliarySample(sample:()=>Promise<void>,report:(error:unknown)=>Promise<void>){
  try{await sample();}catch(error){try{await report(error);}catch(reportError){console.error('Docker resource sample unavailable:',String(error),'report unavailable:',String(reportError));}}
}
