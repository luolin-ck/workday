import Foundation
import Security
import Darwin

struct ACLState: Equatable, Codable {
 var authorizations: [String]
 var applications: [String]?
 var description: String?
 var prompt: UInt32
}
let managedACLMarker="WorkDay managed decrypt v1"
struct ACLUpdate: Equatable {var index:Int?; var applications:[String]; var prompt:UInt32}
func planUpdate(_ acls:[ACLState], app:String) -> ACLUpdate? {
 let decrypt=kSecACLAuthorizationDecrypt as String
 guard app.hasPrefix("/"),!app.contains("\0") else{return nil}
 let marked=acls.indices.filter{acls[$0].description?.hasPrefix("WorkDay managed decrypt")==true}
 guard marked.count<=1 else{return nil}
 if let index=marked.first {
  let acl=acls[index]
  guard acl.description==managedACLMarker,acl.authorizations==[decrypt],acl.applications==[app] else{return nil}
  return ACLUpdate(index:index,applications:[app],prompt:acl.prompt & ~UInt32(SecKeychainPromptSelector.requirePassphase.rawValue))
 }
 // Existing grants are retained verbatim; only a recognized restricted decrypt rule permits adding our own.
 let standard=Set([kSecACLAuthorizationDecrypt,kSecACLAuthorizationSign,kSecACLAuthorizationMAC,kSecACLAuthorizationDerive,kSecACLAuthorizationExportClear,kSecACLAuthorizationExportWrapped].map{$0 as String})
 guard acls.contains(where:{$0.authorizations.contains(decrypt) && Set($0.authorizations).isSubset(of:standard) && $0.applications != nil}) else{return nil}
 return ACLUpdate(index:nil,applications:[app],prompt:0)
}
func sameACLs(_ lhs:[ACLState],_ rhs:[ACLState]) -> Bool {
 guard lhs.count==rhs.count else{return false}
 var remaining=rhs
 for var state in lhs {
  state.authorizations.sort();state.applications?.sort()
  guard let index=remaining.firstIndex(where:{candidate in
   var candidate=candidate;candidate.authorizations.sort();candidate.applications?.sort();return candidate==state
  }) else{return false}
  remaining.remove(at:index)
 }
 return remaining.isEmpty
}

struct Failure: Error {var status:String}
func check(_ status:OSStatus) throws {
 if status != errSecSuccess {
  if status == errSecUserCanceled || status == errSecAuthFailed {throw Failure(status:"cancelled")}
  if status == errSecInteractionNotAllowed {throw Failure(status:"locked")}
  throw Failure(status:"error")
 }
}
func arrayHasType(_ array:CFArray,_ type:CFTypeID) -> Bool {
 (0..<CFArrayGetCount(array)).allSatisfy{index in
  guard let pointer=CFArrayGetValueAtIndex(array,index) else{return false}
  return CFGetTypeID(Unmanaged<AnyObject>.fromOpaque(pointer).takeUnretainedValue())==type
 }
}
func commitAndVerify(write:() throws -> OSStatus,verify:() throws -> Bool) -> String {
 let result:OSStatus
 do {result=try write()}catch{return "unverified"}
 do {try check(result)}catch let error as Failure{return error.status}catch{return "error"}
 do {return try verify() ? "updated":"unverified"}catch{return "unverified"}
}
struct AccessEntries {var acls:[SecACL];var user:uid_t;var group:gid_t;var ownerType:SecAccessOwnerType;var accessAuthorizations:[String]}
func accessEntries(_ access:SecAccess) throws -> AccessEntries {
 var ownerRaw:CFArray?,raw:CFArray?,user:uid_t=0,group:gid_t=0,type:SecAccessOwnerType=0
 // This API returns flattened authorization strings, not SecACL references or owner permissions.
 try check(SecAccessCopyOwnerAndACL(access,&user,&group,&type,&ownerRaw))
 guard let ownerRaw=ownerRaw,arrayHasType(ownerRaw,CFStringGetTypeID()),let owner=ownerRaw as? [String] else{throw Failure(status:"needsManual")}
 try check(SecAccessCopyACLList(access,&raw))
 guard let raw=raw,arrayHasType(raw,SecACLGetTypeID()),let acls=raw as? [SecACL],!acls.isEmpty else{throw Failure(status:"needsManual")}
 return AccessEntries(acls:acls,user:user,group:group,ownerType:type,accessAuthorizations:owner)
}
struct Snapshot:Equatable {
 var acls:[ACLState];var ownerUser:uid_t;var ownerGroup:gid_t;var ownerType:SecAccessOwnerType;var accessAuthorizations:[String]
 static func ==(lhs:Self,rhs:Self)->Bool {
  lhs.ownerUser==rhs.ownerUser && lhs.ownerGroup==rhs.ownerGroup && lhs.ownerType==rhs.ownerType && lhs.accessAuthorizations.sorted()==rhs.accessAuthorizations.sorted() && sameACLs(lhs.acls,rhs.acls)
 }
}
struct Access {var reference:SecAccess;var acls:[SecACL];var applications:[[SecTrustedApplication]?];var snapshot:Snapshot}
func readAccess(_ access:SecAccess) throws -> Access {
 let entries=try accessEntries(access),acls=entries.acls
 var states=[ACLState](),allApplications=[[SecTrustedApplication]?]()
 for acl in acls {
  let rawAuthorizations=SecACLCopyAuthorizations(acl)
  guard arrayHasType(rawAuthorizations,CFStringGetTypeID()),let authorizations=rawAuthorizations as? [String] else{throw Failure(status:"needsManual")}
  var applications:CFArray?,description:CFString?,prompt:SecKeychainPromptSelector=[]
  try check(SecACLCopyContents(acl,&applications,&description,&prompt))
  let apps=applications as? [SecTrustedApplication]
  if let applications=applications {guard arrayHasType(applications,SecTrustedApplicationGetTypeID()),apps != nil else{throw Failure(status:"needsManual")}}
  var paths:[String]?=nil
  if let apps=apps {
   paths=[]
   for app in apps {
    var data:CFData?
    try check(SecTrustedApplicationCopyData(app,&data))
    guard let data=data as Data?,let value=String(data:data.prefix(while:{$0 != 0}),encoding:.utf8),value.hasPrefix("/") else{throw Failure(status:"needsManual")}
    paths!.append(URL(fileURLWithPath:value).standardizedFileURL.resolvingSymlinksInPath().path)
   }
  }
  states.append(ACLState(authorizations:authorizations,applications:paths,description:description as String?,prompt:UInt32(prompt.rawValue)))
  allApplications.append(apps)
 }
 return Access(reference:access,acls:acls,applications:allApplications,snapshot:Snapshot(acls:states,ownerUser:entries.user,ownerGroup:entries.group,ownerType:entries.ownerType,accessAuthorizations:entries.accessAuthorizations))
}
func updateAccess(_ original:Access,app:String,trusted:SecTrustedApplication) throws -> Snapshot {
 guard let update=planUpdate(original.snapshot.acls,app:app) else{throw Failure(status:"needsManual")}
 var target:SecACL?
 if let index=update.index {target=original.acls[index]}
 else {
  try check(SecACLCreateWithSimpleContents(original.reference,[trusted] as CFArray,managedACLMarker as CFString,SecKeychainPromptSelector(rawValue:UInt16(update.prompt)),&target))
 }
 guard let target=target else{throw Failure(status:"needsManual")}
 // Newly created ACLs default to ANY; never persist until narrowed and read back.
 try check(SecACLUpdateAuthorizations(target,[kSecACLAuthorizationDecrypt] as CFArray))
 try check(SecACLSetContents(target,[trusted] as CFArray,managedACLMarker as CFString,SecKeychainPromptSelector(rawValue:UInt16(update.prompt))))
 let result=try readAccess(original.reference).snapshot
 var expected=original.snapshot
 let entry=ACLState(authorizations:[kSecACLAuthorizationDecrypt as String],applications:[app],description:managedACLMarker,prompt:update.prompt)
 if let index=update.index {expected.acls[index]=entry}else{expected.acls.append(entry);expected.accessAuthorizations.append(kSecACLAuthorizationDecrypt as String)}
 guard result==expected,let verified=planUpdate(result.acls,app:app),verified.index != nil else{throw Failure(status:"needsManual")}
 return result
}
func itemReferences(_ array:CFArray) throws -> [SecKeychainItem] {
 guard arrayHasType(array,SecKeychainItemGetTypeID()),let items=array as? [SecKeychainItem] else{throw Failure(status:"needsManual")}
 return items
}
func findUniqueItem<Item>(searchList:CFArray,query:(CFDictionary) throws -> (OSStatus,CFTypeRef?),decode:(CFArray) throws -> [Item]) throws -> Item {
 var matches=[Item]()
 for account in ["WorkDay Key","WorkDay"] {
  let request:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"WorkDay Safe Storage",kSecAttrAccount as String:account,kSecMatchSearchList as String:searchList,kSecReturnRef as String:true,kSecMatchLimit as String:kSecMatchLimitAll]
  let (status,result)=try query(request as CFDictionary)
  if status==errSecItemNotFound {guard result==nil else{throw Failure(status:"needsManual")};continue}
  try check(status)
  guard let result=result,CFGetTypeID(result)==CFArrayGetTypeID() else{throw Failure(status:"needsManual")}
  let items=try decode(result as! CFArray)
  matches.append(contentsOf:items)
 }
 guard !matches.isEmpty else{throw Failure(status:"notFound")}
 guard matches.count==1 else{throw Failure(status:"needsManual")}
 return matches[0]
}
#if KEYCHAIN_FIXTURE
let app="/fixture/WorkDay.app"
let other="/fixture/Other.app"
let decrypt=kSecACLAuthorizationDecrypt as String
let base=ACLState(authorizations:[decrypt],applications:[app,other,app],description:"preserve",prompt:4)
let memoryACLsCorrect:Bool={
 do {
  var access:SecAccess?
  try check(SecAccessCreate("Synthetic WorkDay access" as CFString,[] as CFArray,&access))
  guard let access=access else{return false}
  let entries=try accessEntries(access)
  let decoded=try readAccess(access)
  return !entries.acls.isEmpty && entries.acls.allSatisfy{CFGetTypeID($0)==SecACLGetTypeID()} && decoded.snapshot.acls.count==entries.acls.count && !decoded.snapshot.accessAuthorizations.isEmpty
 }catch{return false}
}()
let standardACLCompatible:Bool={
 do {
  var access:SecAccess?
  try check(SecAccessCreate("Synthetic standard access" as CFString,[] as CFArray,&access))
  guard let access=access else{return false}
  let snapshot=try readAccess(access).snapshot
  return snapshot.acls.contains{$0.authorizations.contains(decrypt) && $0.authorizations.count>1} && planUpdate(snapshot.acls,app:app) != nil
 }catch{return false}
}()
let realMutationChecks:[(String,Bool)]={
 var step="create trusted"
 do {
  var trusted:SecTrustedApplication?,otherTrusted:SecTrustedApplication?,access:SecAccess?,data:CFData?
  try check(SecTrustedApplicationCreateFromPath(nil,&trusted))
  try check(SecTrustedApplicationCreateFromPath("/bin/ls",&otherTrusted))
  guard let trusted=trusted,let otherTrusted=otherTrusted else{throw Failure(status:"error")}
  try check(SecTrustedApplicationCopyData(trusted,&data))
  guard let data=data as Data?,let path=String(data:data.prefix(while:{$0 != 0}),encoding:.utf8) else{throw Failure(status:"error")}
  let currentPath=URL(fileURLWithPath:path).standardizedFileURL.resolvingSymlinksInPath().path
  step="create access"
  try check(SecAccessCreate("Synthetic standard grants" as CFString,[otherTrusted] as CFArray,&access))
  guard let access=access else{throw Failure(status:"error")}
  step="create partition"
  var partition:SecACL?
  try check(SecACLCreateWithSimpleContents(access,[] as CFArray,"Synthetic partition preserved" as CFString,SecKeychainPromptSelector(rawValue:4),&partition))
  guard let partition=partition else{throw Failure(status:"error")}
  try check(SecACLUpdateAuthorizations(partition,[kSecACLAuthorizationPartitionID] as CFArray))
  step="read original"
  let before=try readAccess(access)
  step="first shared update"
  let first=try updateAccess(before,app:currentPath,trusted:trusted)
  step="second shared update"
  var refreshed:SecTrustedApplication?
  try check(SecTrustedApplicationCreateFromPath(currentPath,&refreshed))
  guard let refreshed=refreshed else{throw Failure(status:"error")}
  let second=try updateAccess(readAccess(access),app:currentPath,trusted:refreshed)
  let target=first.acls.filter{$0.description==managedACLMarker}
  var preserved=first;preserved.acls.removeAll{$0.description==managedACLMarker}
  if let index=preserved.accessAuthorizations.firstIndex(of:decrypt){preserved.accessAuthorizations.remove(at:index)}
  var reordered=first;reordered.acls.reverse();reordered.accessAuthorizations.reverse()
  for index in reordered.acls.indices {reordered.acls[index].authorizations.reverse();reordered.acls[index].applications?.reverse()}
  return [
   ("real API creates exactly one dedicated ACL",first.acls.count==before.snapshot.acls.count+1 && target.count==1),
   ("real API narrows default ANY to decrypt and current app",target.first==ACLState(authorizations:[decrypt],applications:[currentPath],description:managedACLMarker,prompt:0)),
   ("real API preserves original mixed ACL owner other apps and prompts",preserved==before.snapshot),
   ("real API refreshes twice without ACL growth",second==first),
   ("snapshot compares semantic multisets rather than API order",reordered==first)
  ]
 }catch {print("Fixture diagnostic: \(step): \(error)");return [("real API shared update succeeds",false)]}
}()
let checks:[(String,Bool)]=[
 ("accepts standard mixed ACL without changing its grants",standardACLCompatible),
 ("refuses unrecognized baseline authorization",planUpdate([ACLState(authorizations:[decrypt,"unknown"],applications:[],description:nil,prompt:0)],app:app)==nil),
 ("refuses unknown marker versions",planUpdate([ACLState(authorizations:[decrypt],applications:[app],description:"WorkDay managed decrypt v2",prompt:0)],app:app)==nil),
 ("enumerates real SecACL objects from synthetic in-memory access",memoryACLsCorrect),
 ("write cancellation never verifies or succeeds",commitAndVerify(write:{errSecUserCanceled},verify:{fatalError("must not verify")})=="cancelled"),
 ("write failure never verifies or succeeds",commitAndVerify(write:{errSecIO},verify:{fatalError("must not verify")})=="error"),
 ("write timeout stays unverified",commitAndVerify(write:{throw Failure(status:"timeout")},verify:{fatalError("must not verify")})=="unverified"),
 ("readback mismatch stays unverified",commitAndVerify(write:{errSecSuccess},verify:{false})=="unverified"),
 ("readback failure stays unverified",commitAndVerify(write:{errSecSuccess},verify:{throw Failure(status:"error")})=="unverified"),
 ("confirmed readback alone succeeds",commitAndVerify(write:{errSecSuccess},verify:{true})=="updated"),
 ("keeps other app grants and adds a separate rule",planUpdate([base],app:app)==ACLUpdate(index:nil,applications:[app],prompt:0)),
 ("clears require-passphrase only in our dedicated rule",planUpdate([ACLState(authorizations:[decrypt],applications:[app],description:managedACLMarker,prompt:5)],app:app)?.prompt==4),
 ("refuses dedicated marker with other apps",planUpdate([ACLState(authorizations:[decrypt],applications:[other],description:managedACLMarker,prompt:1)],app:app)==nil),
 ("refuses only all-applications rules",planUpdate([ACLState(authorizations:[decrypt],applications:nil,description:nil,prompt:0)],app:app)==nil),
 ("refuses mixed authorization in dedicated marker",planUpdate([ACLState(authorizations:[decrypt,"other"],applications:[app],description:managedACLMarker,prompt:0)],app:app)==nil),
 ("refuses duplicate dedicated markers",planUpdate([ACLState(authorizations:[decrypt],applications:[app],description:managedACLMarker,prompt:0),ACLState(authorizations:[decrypt],applications:[app],description:managedACLMarker,prompt:0)],app:app)==nil),
 ("preserves non-target ACL",planUpdate([ACLState(authorizations:["partition"],applications:nil,description:"owner",prompt:8),base],app:app)==ACLUpdate(index:nil,applications:[app],prompt:0)),
 ("adds current app separately from an empty trusted list",planUpdate([ACLState(authorizations:[decrypt],applications:[],description:nil,prompt:1)],app:app)==ACLUpdate(index:nil,applications:[app],prompt:0))
]
func lookupFixture(_ responses:[String:(OSStatus,CFTypeRef?)],throwingOn:String?=nil) -> (String,[String],Bool) {
 var accounts=[String](),parametersValid=true
 do {
  let value:String=try findUniqueItem(searchList:["synthetic-default"] as CFArray,query:{raw in
   let request=raw as NSDictionary,account=request[kSecAttrAccount] as? String ?? ""
   accounts.append(account)
   parametersValid = parametersValid && request.count==6 && request[kSecClass] as? String==kSecClassGenericPassword as String && request[kSecAttrService] as? String=="WorkDay Safe Storage" && request[kSecMatchSearchList] as? [String]==["synthetic-default"] && request[kSecReturnRef] as? Bool==true && request[kSecMatchLimit] as? String==kSecMatchLimitAll as String && request[kSecReturnData]==nil && request[kSecValueData]==nil
   if account==throwingOn {throw NSError(domain:"synthetic-query",code:1)}
   return responses[account] ?? (errSecItemNotFound,nil)
  },decode:{array in
   guard arrayHasType(array,CFStringGetTypeID()),let values=array as? [String] else{throw Failure(status:"needsManual")}
   return values
  })
  return (value,accounts,parametersValid)
 }catch let failure as Failure{return (failure.status,accounts,parametersValid)}
 catch{return ("thrown",accounts,parametersValid)}
}
let currentResult:(OSStatus,CFTypeRef?)=(errSecSuccess,["current"] as CFArray)
let legacyResult:(OSStatus,CFTypeRef?)=(errSecSuccess,["legacy"] as CFArray)
let currentLookup=lookupFixture(["WorkDay Key":currentResult])
let legacyLookup=lookupFixture(["WorkDay":legacyResult])
let queryErrors:[(OSStatus,String)]=[(errSecIO,"error"),(errSecParam,"error"),(errSecInteractionNotAllowed,"locked"),(errSecUserCanceled,"cancelled"),(errSecAuthFailed,"cancelled")]
let productionDecoderRejects:Bool={do{_ = try itemReferences(["not-an-item"] as CFArray);return false}catch{return true}}()
let lookupChecks:[(String,Bool)]=[
 ("finds current Electron Key-suffixed account",currentLookup.0=="current"),
 ("finds legacy unsuffixed account",legacyLookup.0=="legacy"),
 ("no fixed account returns notFound",lookupFixture([:]).0=="notFound"),
 ("both fixed accounts require manual resolution",lookupFixture(["WorkDay Key":currentResult,"WorkDay":legacyResult]).0=="needsManual"),
 ("duplicate current references require manual resolution",lookupFixture(["WorkDay Key":(errSecSuccess,["current","current"] as CFArray)]).0=="needsManual"),
 ("duplicate legacy references require manual resolution",lookupFixture(["WorkDay":(errSecSuccess,["legacy","legacy"] as CFArray)]).0=="needsManual"),
 ("same reference in both accounts still conflicts",lookupFixture(["WorkDay Key":currentResult,"WorkDay":currentResult]).0=="needsManual"),
 ("every current query error blocks legacy selection",queryErrors.allSatisfy{lookupFixture(["WorkDay Key":($0.0,nil),"WorkDay":legacyResult]).0==$0.1}),
 ("every legacy query error blocks current selection",queryErrors.allSatisfy{lookupFixture(["WorkDay Key":currentResult,"WorkDay":($0.0,nil)]).0==$0.1}),
 ("thrown current query blocks legacy selection",lookupFixture(["WorkDay":legacyResult],throwingOn:"WorkDay Key").0=="thrown"),
 ("thrown legacy query blocks current selection",lookupFixture(["WorkDay Key":currentResult],throwingOn:"WorkDay").0=="thrown"),
 ("success without a result fails closed",lookupFixture(["WorkDay Key":(errSecSuccess,nil)]).0=="needsManual"),
 ("nonarray result fails closed",lookupFixture(["WorkDay Key":(errSecSuccess,"unknown" as CFString)]).0=="needsManual"),
 ("empty reference array contributes zero matches",lookupFixture(["WorkDay Key":(errSecSuccess,[] as CFArray)]).0=="notFound"),
 ("unknown array elements fail closed",lookupFixture(["WorkDay Key":(errSecSuccess,[42] as CFArray)]).0=="needsManual"),
 ("notFound with an unexpected result fails closed",lookupFixture(["WorkDay Key":(errSecItemNotFound,"unknown" as CFString),"WorkDay":legacyResult]).0=="needsManual"),
 ("production decoder rejects non-SecKeychainItem CF types",productionDecoderRejects),
 ("queries use only fixed service accounts default references and no secret data",currentLookup.2 && legacyLookup.2),
 ("all accounts are queried even after a current match",currentLookup.1==["WorkDay Key","WorkDay"] && legacyLookup.1==["WorkDay Key","WorkDay"])
]
let allChecks=checks+realMutationChecks+lookupChecks
for (name,passed) in allChecks {print("\(passed ? "PASS":"FAIL") \(name)")}
exit(allChecks.allSatisfy{$0.1} ? 0:1)
#else
struct Outcome: Codable {var status:String;var signing:String="unknown"}
func diagnostic(_ step:String) {
 #if KEYCHAIN_DIAGNOSTIC
 FileHandle.standardError.write(Data((step+"\n").utf8))
 #endif
}
func processPath(_ pid:pid_t) throws -> String {
 diagnostic("process-path-start")
 var bytes=[CChar](repeating:0,count:4*Int(MAXPATHLEN))
 guard proc_pidpath(pid,&bytes,UInt32(bytes.count))>0 else{throw Failure(status:"unsupportedPackage")}
 diagnostic("process-path-done")
 return String(cString:bytes)
}
struct Identity: Equatable {var app:String;var signature:Data;var signing:String}
func identity() throws -> Identity {
 diagnostic("identity-start")
 let parent=try processPath(getppid()),own=try processPath(getpid())
 diagnostic("identity-paths")
 let app=URL(fileURLWithPath:parent).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
 guard URL(fileURLWithPath:app).lastPathComponent=="WorkDay.app",
       parent==app+"/Contents/MacOS/Electron",
       own==app+"/Contents/Resources/app/native/keychain-access",
       URL(fileURLWithPath:app).resolvingSymlinksInPath().path==app,
       URL(fileURLWithPath:parent).resolvingSymlinksInPath().path==parent,
       URL(fileURLWithPath:own).resolvingSymlinksInPath().path==own,
       Bundle(path:app)?.bundleIdentifier=="local.workday.desktop" else{throw Failure(status:"unsupportedPackage")}
 diagnostic("identity-guard-passed")
 var code:SecStaticCode?
 try check(SecStaticCodeCreateWithPath(URL(fileURLWithPath:app) as CFURL,[],&code))
 guard let code=code else{throw Failure(status:"unsupportedPackage")}
 try check(SecStaticCodeCheckValidity(code,SecCSFlags(rawValue:kSecCSStrictValidate),nil))
 var information:CFDictionary?
 try check(SecCodeCopySigningInformation(code,SecCSFlags(rawValue:kSecCSSigningInformation),&information))
 guard let info=information as? [String:Any],let signature=info[kSecCodeInfoUnique as String] as? Data else{throw Failure(status:"unsupportedPackage")}
 let flags=(info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
 return Identity(app:app,signature:signature,signing:flags & 2 != 0 ? "adhoc":"signed")
}
func findItem() throws -> SecKeychainItem {
 var keychain:SecKeychain?
 try check(SecKeychainCopyDefault(&keychain))
 guard let keychain=keychain else{throw Failure(status:"unknown")}
 var status:SecKeychainStatus=0
 try check(SecKeychainGetStatus(keychain,&status))
 guard status & kSecUnlockStateStatus != 0 else{throw Failure(status:"locked")}
 return try findUniqueItem(searchList:[keychain] as CFArray,query:{request in
  var result:CFTypeRef?
  let status=SecItemCopyMatching(request,&result)
  return (status,result)
 },decode:itemReferences)
}
func copyAccess(_ item:SecKeychainItem) throws -> Access {
 var access:SecAccess?
 try check(SecKeychainItemCopyAccess(item,&access))
 guard let access=access else{throw Failure(status:"needsManual")}
 return try readAccess(access)
}
func operate(_ command:String) -> Outcome {
 var signing="unknown"
 do {
  diagnostic("operate-start")
  let current=try identity();signing=current.signing
  #if KEYCHAIN_DIAGNOSTIC
  return Outcome(status:"unsupportedPackage",signing:signing)
  #endif
  try check(SecKeychainSetUserInteractionAllowed(false))
  let item=try findItem(),original=try copyAccess(item)
  guard planUpdate(original.snapshot.acls,app:current.app) != nil else{return Outcome(status:"needsManual",signing:signing)}
  if command=="status" {return Outcome(status:original.snapshot.acls.contains{$0.authorizations.contains(kSecACLAuthorizationDecrypt as String) && $0.applications?.contains(current.app)==true} ? "listed":"notListed",signing:signing)}
  // Recheck both the unique item and every access entry before permitting a write.
  guard try identity()==current,CFEqual(try findItem(),item),try copyAccess(item).snapshot==original.snapshot else{throw Failure(status:"unknown")}
  var trusted:SecTrustedApplication?
  try check(SecTrustedApplicationCreateFromPath(current.app,&trusted))
  guard let trusted=trusted else{throw Failure(status:"error")}
  let expected=try updateAccess(original,app:current.app,trusted:trusted)
  guard try identity()==current else{throw Failure(status:"unknown")}
  try check(SecKeychainSetUserInteractionAllowed(true))
  let status=commitAndVerify(write:{SecKeychainItemSetAccess(item,original.reference)},verify:{
   try check(SecKeychainSetUserInteractionAllowed(false))
   return try identity()==current && CFEqual(try findItem(),item) && copyAccess(item).snapshot==expected
  })
  return Outcome(status:status,signing:signing)
 }catch let failure as Failure{return Outcome(status:failure.status,signing:signing)}
 catch{return Outcome(status:"error",signing:signing)}
}
let args=CommandLine.arguments
let outcome=args.count==2 && ["status","configure"].contains(args[1]) ? operate(args[1]):Outcome(status:"error")
if let data=try? JSONEncoder().encode(outcome){FileHandle.standardOutput.write(data)}

#endif
