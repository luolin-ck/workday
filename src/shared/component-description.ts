/** Display metadata never replaces the source description used by the component. */
export function componentDescription(value:{description:string;descriptionZh?:string}):string {
 return value.descriptionZh?.trim()||value.description;
}
