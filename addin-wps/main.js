// Legacy loader kept for WPS template compatibility.
// index.html loads host.js -> js/trail.js -> js/ribbon.js directly; this file
// exists so older packages that reference main.js keep working.
document.write("<script language='javascript' src='host.js'></script>");
document.write("<script language='javascript' src='js/trail.js'></script>");
document.write("<script language='javascript' src='js/ribbon.js'></script>");
