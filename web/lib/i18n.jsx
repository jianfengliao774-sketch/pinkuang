'use client';
import {createContext,useContext,useEffect,useState,useCallback} from 'react';
import {platformEn} from './platform-en';
import {catalogEn} from './catalog-en';
import {homeEn} from './home-en';
const en={...platformEn,...catalogEn,...homeEn};
const interpolate=(text,params={})=>String(text).replace(/\{(\w+)\}/g,(all,key)=>params[key]??all);
const I18nContext=createContext({locale:'zh',setLocale:()=>{},t:interpolate});
export function I18nProvider({children}){
 const [locale,setLanguage]=useState('zh');
 useEffect(()=>{try{const saved=localStorage.getItem('bemine-language');if(saved==='en'||saved==='zh')setLanguage(saved)}catch{}},[]);
 useEffect(()=>{document.documentElement.lang=locale==='en'?'en':'zh-CN'},[locale]);
 const setLocale=useCallback(value=>{if(!['zh','en'].includes(value))return;setLanguage(value);try{localStorage.setItem('bemine-language',value)}catch{}},[]);
 const t=useCallback((source,params)=>interpolate(locale==='en'?(en[source]??source):source,params),[locale]);
 return <I18nContext.Provider value={{locale,setLocale,t}}>{children}</I18nContext.Provider>;
}
export const useI18n=()=>useContext(I18nContext);

// The review book must not overwrite visitors' saved product preferences.
export function ReviewI18nProvider({children,initialLocale='zh'}){
 const [locale,setLocale]=useState(initialLocale);
 useEffect(()=>{document.documentElement.lang=locale==='en'?'en':'zh-CN'},[locale]);
 const t=useCallback((source,params)=>interpolate(locale==='en'?(en[source]??source):source,params),[locale]);
 return <I18nContext.Provider value={{locale,setLocale,t}}>{children}</I18nContext.Provider>;
}
