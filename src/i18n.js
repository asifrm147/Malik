import { createContext, useContext } from 'react';

export const STAGES = {
  en: [['Awaiting appointment / review', 'Your appointment or records review has not yet been completed.'], ['Report in preparation', 'Work on your report has started.'], ['Dictated', 'The initial report has been dictated.'], ['Proofed and compiled', 'The report has been proofread and supporting material assembled.'], ['In quality control', 'The report is undergoing its final review.'], ['Ready for download', 'Your report has been released and is available securely.']],
  es: [['En espera de cita / revisión', 'Su cita o revisión de expedientes aún no se ha completado.'], ['Informe en preparación', 'Se comenzó a trabajar en su informe.'], ['Dictado', 'El informe inicial ha sido dictado.'], ['Revisado y compilado', 'El informe fue revisado y se reunió el material de apoyo.'], ['En control de calidad', 'El informe está en su revisión final.'], ['Listo para descargar', 'Su informe fue entregado y está disponible de forma segura.']],
};

const T = {
  en: {
    welcome: 'Welcome back', next: 'Your next step', signOut: 'Sign out', language: 'Español',
    ns_verify: 'Verify your identity', ns_verifyD: 'Dr. Malik needs to confirm who you are before your video visit. It takes a few minutes with ID.me.', verifyBtn: 'Verify with ID.me',
    ns_hold: 'Upload requested records', ns_recv: 'We received your upload', ns_recvD: 'Dr. Malik will confirm it covers everything requested. Nothing else is needed from you for now.',
    ns_paper: 'Complete your paperwork', ns_paperD: '{n} item(s) left. Your answers save as you go, so you can finish later.', ns_pay: 'Complete payment', ns_payD: 'Your request is saved. Payment is due before work begins.',
    ns_join: 'Join your video appointment', ns_joinD: 'The waiting room opens 15 minutes before your appointment.', ns_dl: 'Download your report', ns_dlD: 'Version {v} was released on {d}.',
    ns_wait: 'Nothing needed from you right now', ns_waitD: 'We will let you know when your report moves forward.', ns_book: 'Book a consultation', ns_bookD: 'Choose a Monday appointment.',
    appt: 'Upcoming appointment', join: 'Join video', apptLen: 'Video visit with Dr. Malik · {m} minutes',
    status: 'Report status', done: 'Done', current: 'Current', notStarted: 'Not started', onHold: 'On hold',
    holdT: 'Pending additional records/information', what: 'What is needed', who: 'Who provides it', how: 'How to submit', holdStage: 'Your report stays at “{s}” until this is resolved.', submitInfo: 'Submit requested information', holdRecv: 'Received {d}. Waiting for Dr. Malik to confirm it is complete.',
    yourReport: 'Your report', notRel: 'Your report will appear here after Dr. Malik approves and releases it.', ver: 'Version {v} · released {d}', curVer: 'Current version', dl: 'Download PDF',
    prep: 'Get ready', count: '{a} of {b} complete', start: 'Start', cont: 'Continue', submitted: 'Submitted {d}', saved: 'Saved, not yet submitted', saveDraft: 'Save and finish later', submit: 'Submit', close: 'Close',
    docs: 'Secure documents', docsP: 'Upload records, letters or forms. You will get a receipt for each file.', choose: 'Choose file', uploading: 'Uploading…', noDocs: 'No documents yet.', received: 'Received', receipt: 'Receipt',
    updates: 'Updates', noUpdates: 'No updates yet.', markRead: 'Mark all read',
    email: 'Email notifications', emailOn: 'Email me when there is an update', reminders: 'Email appointment reminders', emailNote: 'Emails only say there is an update in your secure account, with a sign-in link. You can always sign in to see your status.', save: 'Save preferences', saved2: 'Preferences saved.',
    need: 'What do you need?', aSched: 'Schedule an appointment', aReport: 'Request a report', aSubmit: 'Submit requested information',
    safety: 'Emergencies: call 911. Crisis: call or text 988. Medication or follow-up problems: use the clinical-safety contact in your visit plan.',
    accessP: 'Reports requested by an insurer, employer or attorney are released only to the recipients they authorize.', accessO: 'Only people your organization authorizes for this case can see it.',
    cases: 'Your cases', newReq: 'New request', caseCols: ['Case', 'Service', 'Status', 'Last update', 'Outstanding'], none: 'None',
    idVerified: 'Identity verified', notLinked: 'Your account is approved but not yet linked to your organization. Dr. Malik’s office will link it shortly.',
  },
  es: {
    welcome: 'Bienvenido de nuevo', next: 'Su próximo paso', signOut: 'Cerrar sesión', language: 'English',
    ns_verify: 'Verifique su identidad', ns_verifyD: 'El Dr. Malik necesita confirmar quién es usted antes de su visita por video. Toma unos minutos con ID.me.', verifyBtn: 'Verificar con ID.me',
    ns_hold: 'Subir los registros solicitados', ns_recv: 'Recibimos su archivo', ns_recvD: 'El Dr. Malik confirmará que incluye todo lo solicitado. Por ahora no necesita hacer nada más.',
    ns_paper: 'Complete sus formularios', ns_paperD: 'Quedan {n}. Sus respuestas se guardan; puede terminar después.', ns_pay: 'Complete el pago', ns_payD: 'Su solicitud está guardada. El pago se requiere antes de comenzar.',
    ns_join: 'Únase a su cita por video', ns_joinD: 'La sala de espera abre 15 minutos antes de su cita.', ns_dl: 'Descargue su informe', ns_dlD: 'La versión {v} se entregó el {d}.',
    ns_wait: 'No necesitamos nada de usted por ahora', ns_waitD: 'Le avisaremos cuando su informe avance.', ns_book: 'Programe una consulta', ns_bookD: 'Elija una cita de lunes.',
    appt: 'Próxima cita', join: 'Entrar al video', apptLen: 'Visita por video con el Dr. Malik · {m} minutos',
    status: 'Estado del informe', done: 'Completado', current: 'Actual', notStarted: 'Sin iniciar', onHold: 'En espera',
    holdT: 'Pendiente de registros o información adicional', what: 'Qué se necesita', who: 'Quién lo proporciona', how: 'Cómo enviarlo', holdStage: 'Su informe permanece en “{s}” hasta resolver esto.', submitInfo: 'Enviar la información solicitada', holdRecv: 'Recibido el {d}. En espera de que el Dr. Malik confirme que está completo.',
    yourReport: 'Su informe', notRel: 'Su informe aparecerá aquí cuando el Dr. Malik lo apruebe y lo entregue.', ver: 'Versión {v} · entregada el {d}', curVer: 'Versión actual', dl: 'Descargar PDF',
    prep: 'Prepárese', count: '{a} de {b} completados', start: 'Comenzar', cont: 'Continuar', submitted: 'Enviado el {d}', saved: 'Guardado, aún no enviado', saveDraft: 'Guardar y terminar después', submit: 'Enviar', close: 'Cerrar',
    docs: 'Documentos seguros', docsP: 'Suba registros, cartas o formularios. Recibirá un comprobante por cada archivo.', choose: 'Elegir archivo', uploading: 'Subiendo…', noDocs: 'Aún no hay documentos.', received: 'Recibido', receipt: 'Comprobante',
    updates: 'Avisos', noUpdates: 'Aún no hay avisos.', markRead: 'Marcar como leídos',
    email: 'Avisos por correo', emailOn: 'Enviarme un correo cuando haya una actualización', reminders: 'Recordatorios de cita por correo', emailNote: 'Los correos solo indican que hay una actualización en su cuenta segura, con un enlace para iniciar sesión. Siempre puede iniciar sesión para ver su estado.', save: 'Guardar preferencias', saved2: 'Preferencias guardadas.',
    need: '¿Qué necesita?', aSched: 'Programar una cita', aReport: 'Solicitar un informe', aSubmit: 'Enviar la información solicitada',
    safety: 'Emergencias: llame al 911. Crisis: llame o envíe un texto al 988. Problemas con medicamentos o seguimiento: use el contacto de seguridad clínica de su plan.',
    accessP: 'Los informes solicitados por una aseguradora, empleador o abogado solo se entregan a los destinatarios que ellos autorizan.', accessO: 'Solo las personas autorizadas por su organización para este caso pueden verlo.',
    cases: 'Sus casos', newReq: 'Nueva solicitud', caseCols: ['Caso', 'Servicio', 'Estado', 'Última actualización', 'Pendiente'], none: 'Nada',
    idVerified: 'Identidad verificada', notLinked: 'Su cuenta está aprobada pero aún no está vinculada a su organización. La oficina del Dr. Malik la vinculará pronto.',
  },
};

export const LangCtx = createContext({ lang: 'en', setLang: () => {} });
export function useT() {
  const { lang, setLang } = useContext(LangCtx);
  const t = (k, v = {}) => Object.entries(v).reduce((s, [a, b]) => s.replace(`{${a}}`, b), T[lang][k] ?? T.en[k] ?? k);
  return { t, lang, setLang, stages: STAGES[lang] };
}
export const fmtDate = (iso, lang = 'en') => iso ? new Date(iso).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
export const fmtDateTime = (iso, lang = 'en') => iso ? new Date(iso).toLocaleString(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles', timeZoneName: 'short' }) : '';
