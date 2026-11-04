// Runs only in isolated smoke tests, at the paused application entry.
function installMeetingsFixture(options, Meetings) {
 const fixture=globalThis.__meetingsFixture={installedBeforeEntry:true,calls:[],status:'notDetermined',meetings:[],delayMs:0,queued:[],...options};
 Meetings.prototype.query=async function(input){
  fixture.calls.push(JSON.parse(JSON.stringify(input)));
  const snapshot=JSON.parse(JSON.stringify({...fixture,...fixture.queued.shift()}));
  await new Promise(resolve=>setTimeout(resolve,snapshot.delayMs??0));
  return {startDate:input.startDate,endDate:input.endDate,timezone:input.timezone,status:snapshot.status,meetings:snapshot.status==='ready'?snapshot.meetings:[],message:snapshot.status==='ready'?null:'合成日历状态：'+snapshot.status};
 };
}
module.exports={installMeetingsFixture};
